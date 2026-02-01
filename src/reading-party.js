import Gtk from 'gi://Gtk'
import Adw from 'gi://Adw'
import GObject from 'gi://GObject'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import Soup from 'gi://Soup?version=3.0'
import { gettext as _ } from 'gettext'

import * as utils from './utils.js'
import { debounce, settings } from './utils.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const ReadingPartyClient = GObject.registerClass({
    GTypeName: 'FoliateReadingPartyClient',
    Signals: {
        'connected': {},
        'disconnected': {},
        'state-updated': { param_types: [GObject.TYPE_JSOBJECT] },
        'member-joined': { param_types: [GObject.TYPE_JSOBJECT] },
        'member-left': { param_types: [GObject.TYPE_JSOBJECT] },
        'progress-updated': { param_types: [GObject.TYPE_JSOBJECT] },
        'annotation-received': { param_types: [GObject.TYPE_JSOBJECT] },
        'annotation-deleted': { param_types: [GObject.TYPE_JSOBJECT] },
        'comment-received': { param_types: [GObject.TYPE_JSOBJECT] },
        'error': { param_types: [GObject.TYPE_JSOBJECT] },
    },
}, class extends GObject.Object {
    #session
    #wsConnection
    #partyState
    #settings
    #reconnectDelay = 1000
    #reconnectTimer = null
    #shouldReconnect = false
    #destroyed = false

    constructor(params) {
        super(params)
        this.#session = new Soup.Session()
        this.#settings = settings('reading-party')
        this.sendProgress = debounce(this.#sendProgressImmediate.bind(this), 500)
    }

    get serverUrl() {
        return this.#settings?.get_string('server-url') || 'http://localhost:3000'
    }

    get nickname() {
        return this.#settings?.get_string('nickname') || ''
    }

    get memberId() {
        return this.#settings?.get_string('member-id') || ''
    }

    get partyId() {
        return this.#settings?.get_string('party-id') || ''
    }

    get autoConnect() {
        return this.#settings?.get_boolean('auto-connect') || false
    }

    get isConnected() {
        return this.#wsConnection != null
    }

    get partyState() {
        return this.#partyState
    }

    #saveSetting(key, value) {
        if (!this.#settings) return
        if (typeof value === 'string') this.#settings.set_string(key, value)
        else if (typeof value === 'boolean') this.#settings.set_boolean(key, value)
    }

    async #restRequest(method, path, body) {
        const url = `${this.serverUrl}/api${path}`
        const msg = Soup.Message.new(method, url)
        if (!msg) throw new Error(`Invalid URL: ${url}`)

        if (body) {
            const json = JSON.stringify(body)
            const bytes = GLib.Bytes.new(encoder.encode(json))
            msg.set_request_body_from_bytes('application/json', bytes)
        }

        return new Promise((resolve, reject) => {
            this.#session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res)
                    const status = msg.get_status()
                    const responseText = decoder.decode(bytes.get_data())
                    const data = JSON.parse(responseText)
                    if (status >= 200 && status < 300) {
                        resolve(data)
                    } else {
                        reject(new Error(data.error || `HTTP ${status}`))
                    }
                } catch (e) {
                    reject(e)
                }
            })
        })
    }

    async createParty(name) {
        const party = await this.#restRequest('POST', '/parties', { name })
        this.#partyState = party
        return party
    }

    async joinParty(inviteCode, nickname) {
        const result = await this.#restRequest('POST', '/parties/join', {
            inviteCode,
            nickname,
        })
        this.#saveSetting('party-id', result.partyId)
        this.#saveSetting('member-id', result.memberId)
        this.#saveSetting('nickname', nickname)
        this.#partyState = result.party
        return result
    }

    async leaveParty() {
        const partyId = this.partyId
        const memberId = this.memberId
        if (partyId && memberId) {
            try {
                await this.#restRequest('DELETE', `/parties/${partyId}/members/${memberId}`)
            } catch (e) {
                console.warn('Failed to leave party:', e.message)
            }
        }
        this.disconnect()
        this.#saveSetting('party-id', '')
        this.#saveSetting('member-id', '')
        this.#saveSetting('auto-connect', false)
        this.#partyState = null
    }

    async fetchPartyState() {
        const partyId = this.partyId
        if (!partyId) return null
        const state = await this.#restRequest('GET', `/parties/${partyId}`)
        this.#partyState = state
        return state
    }

    connectWs() {
        const partyId = this.partyId
        const memberId = this.memberId
        if (!partyId || !memberId) {
            this.emit('error', { message: 'Not in a party' })
            return
        }

        this.#shouldReconnect = true
        this.#clearReconnectTimer()

        const wsUrl = this.serverUrl.replace(/^http/, 'ws') + `/ws?partyId=${partyId}&memberId=${memberId}`
        const msg = Soup.Message.new('GET', wsUrl)
        if (!msg) {
            this.emit('error', { message: `Invalid WebSocket URL: ${wsUrl}` })
            return
        }

        this.#session.websocket_connect_async(msg, null, null, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            try {
                this.#wsConnection = session.websocket_connect_finish(res)
                this.#reconnectDelay = 1000 // reset backoff on success
                console.log('[ReadingParty] WebSocket connected')

                this.#wsConnection.connect('message', (_conn, type, data) => {
                    if (type !== Soup.WebsocketDataType.TEXT) return
                    try {
                        const text = decoder.decode(data.get_data())
                        const msg = JSON.parse(text)
                        this.#handleMessage(msg)
                    } catch (e) {
                        console.error('[ReadingParty] Failed to parse message:', e.message)
                    }
                })

                this.#wsConnection.connect('closed', () => {
                    console.log('[ReadingParty] WebSocket closed')
                    this.#wsConnection = null
                    this.emit('disconnected')
                    this.#scheduleReconnect()
                })

                this.#wsConnection.connect('error', (_conn, err) => {
                    console.error('[ReadingParty] WebSocket error:', err.message)
                    this.emit('error', { message: err.message })
                })

                this.emit('connected')
            } catch (e) {
                console.error('[ReadingParty] WebSocket connect failed:', e.message)
                this.emit('error', { message: e.message })
                this.#scheduleReconnect()
            }
        })
    }

    #scheduleReconnect() {
        if (!this.#shouldReconnect || this.#destroyed) return
        console.log(`[ReadingParty] Reconnecting in ${this.#reconnectDelay}ms...`)
        this.#reconnectTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.#reconnectDelay, () => {
            this.#reconnectTimer = null
            if (this.#shouldReconnect && !this.#destroyed) this.connectWs()
            return GLib.SOURCE_REMOVE
        })
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max
        this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, 30000)
    }

    #clearReconnectTimer() {
        if (this.#reconnectTimer) {
            GLib.source_remove(this.#reconnectTimer)
            this.#reconnectTimer = null
        }
    }

    disconnect() {
        this.#shouldReconnect = false
        this.#clearReconnectTimer()
        if (this.#wsConnection) {
            try {
                this.#wsConnection.close(Soup.WebsocketCloseCode.NORMAL, null)
            } catch (e) {
                console.warn('[ReadingParty] Error closing WebSocket:', e.message)
            }
            this.#wsConnection = null
        }
    }

    #handleMessage(msg) {
        switch (msg.type) {
            case 'state':
                this.#partyState = msg.party
                this.emit('state-updated', msg.party)
                break
            case 'member-joined':
                if (this.#partyState) {
                    this.#partyState.members[msg.memberId] = {
                        nickname: msg.nickname,
                        joinedAt: new Date().toISOString(),
                        progress: {},
                    }
                }
                this.emit('member-joined', msg)
                break
            case 'member-left':
                if (this.#partyState) {
                    delete this.#partyState.members[msg.memberId]
                }
                this.emit('member-left', msg)
                break
            case 'progress':
                if (this.#partyState?.members[msg.memberId]) {
                    this.#partyState.members[msg.memberId].progress[msg.bookId] = {
                        cfi: msg.cfi,
                        fraction: msg.fraction,
                        updatedAt: new Date().toISOString(),
                    }
                }
                this.emit('progress-updated', msg)
                break
            case 'annotation':
                if (this.#partyState) {
                    const idx = this.#partyState.annotations.findIndex(a => a.id === msg.annotation.id)
                    if (idx >= 0) this.#partyState.annotations[idx] = msg.annotation
                    else this.#partyState.annotations.push(msg.annotation)
                }
                this.emit('annotation-received', msg)
                break
            case 'delete-annotation':
                if (this.#partyState) {
                    this.#partyState.annotations = this.#partyState.annotations
                        .filter(a => a.id !== msg.annotationId)
                }
                this.emit('annotation-deleted', msg)
                break
            case 'comment':
                if (this.#partyState) {
                    this.#partyState.comments.push(msg.comment)
                }
                this.emit('comment-received', msg)
                break
            default:
                console.log('[ReadingParty] Unknown message type:', msg.type)
        }
    }

    #send(msg) {
        if (!this.#wsConnection) return
        try {
            this.#wsConnection.send_text(JSON.stringify(msg))
        } catch (e) {
            console.error('[ReadingParty] Failed to send:', e.message)
        }
    }

    #sendProgressImmediate(bookId, cfi, fraction) {
        this.#send({ type: 'progress', bookId, cfi, fraction })
    }

    sendAnnotation(bookId, annotation) {
        this.#send({ type: 'annotation', bookId, annotation })
    }

    deleteAnnotation(bookId, annotationId) {
        this.#send({ type: 'delete-annotation', bookId, annotationId })
    }

    sendComment(bookId, text, cfi) {
        this.#send({ type: 'comment', bookId, text, cfi })
    }

    destroy() {
        this.#destroyed = true
        this.disconnect()
    }
})

const formatTime = iso => {
    if (!iso) return ''
    try {
        const d = new Date(iso)
        return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    } catch { return '' }
}

export const ReadingPartyPanel = GObject.registerClass({
    GTypeName: 'FoliateReadingPartyPanel',
    Template: pkg.moduleuri('ui/reading-party.ui'),
    InternalChildren: [
        'party-stack',
        'create-button', 'join-button',
        'party-name-label', 'invite-code-label', 'copy-code-button',
        'members-list', 'comments-list',
        'comment-entry', 'send-comment-button',
        'leave-button',
    ],
    Signals: {
        'go-to-cfi': { param_types: [GObject.TYPE_STRING] },
    },
}, class extends Gtk.Box {
    #client
    #bookId

    constructor(params) {
        super(params)
        this.#client = new ReadingPartyClient()

        this._create_button.connect('clicked', () => this.#showCreateDialog())
        this._join_button.connect('clicked', () => this.#showJoinDialog())
        this._leave_button.connect('clicked', () => this.#leave())
        this._copy_code_button.connect('clicked', () => {
            const code = this._invite_code_label.label
            if (code) utils.setClipboardText(code)
        })
        this._send_comment_button.connect('clicked', () => this.#sendComment())
        this._comment_entry.connect('activate', () => this.#sendComment())

        utils.connect(this.#client, {
            'connected': () => {
                this.#saveSetting('auto-connect', true)
            },
            'disconnected': () => {
                // If we still have party info, show empty state with reconnect option
                if (this.#client.partyId) {
                    this._party_stack.visible_child_name = 'empty'
                }
            },
            'state-updated': (_, state) => {
                this.#showConnectedState(state)
            },
            'member-joined': () => this.#refreshMembers(),
            'member-left': () => this.#refreshMembers(),
            'progress-updated': () => this.#refreshMembers(),
            'comment-received': (_, msg) => this.#addCommentRow(msg.comment),
            'annotation-received': () => {},
            'annotation-deleted': () => {},
            'error': (_, err) => {
                console.error('[ReadingPartyPanel] Error:', err.message)
                // Show error toast if we have a root window
                const root = this.get_root()
                if (root?.add_toast) {
                    root.add_toast(new Adw.Toast({ title: err.message, timeout: 3 }))
                }
            },
        })

        // If already in a party, try to reconnect
        if (this.#client.partyId && this.#client.memberId) {
            this._party_stack.visible_child_name = 'connecting'
            this.#client.connectWs()
        }
    }

    get client() { return this.#client }

    set bookId(id) { this.#bookId = id }
    get bookId() { return this.#bookId }

    #saveSetting(key, value) {
        const s = settings('reading-party')
        if (!s) return
        if (typeof value === 'string') s.set_string(key, value)
        else if (typeof value === 'boolean') s.set_boolean(key, value)
    }

    #showCreateDialog() {
        const dialog = new Adw.AlertDialog({
            heading: _('Create Reading Party'),
            body: _('Enter a name for your reading party'),
            close_response: 'cancel',
        })
        dialog.add_response('cancel', _('Cancel'))
        dialog.add_response('create', _('Create'))
        dialog.set_response_appearance('create', Adw.ResponseAppearance.SUGGESTED)

        const group = new Adw.PreferencesGroup()
        const nameRow = new Adw.EntryRow({ title: _('Party Name') })
        const nicknameRow = new Adw.EntryRow({ title: _('Your Nickname') })
        const serverRow = new Adw.EntryRow({ title: _('Server URL') })
        serverRow.text = this.#client.serverUrl
        nicknameRow.text = this.#client.nickname

        group.add(nameRow)
        group.add(nicknameRow)
        group.add(serverRow)
        dialog.set_extra_child(group)

        dialog.connect('response', async (_, response) => {
            if (response !== 'create') return
            const name = nameRow.text.trim()
            const nickname = nicknameRow.text.trim()
            const serverUrl = serverRow.text.trim()
            if (!name || !nickname) return

            this.#saveSetting('server-url', serverUrl)
            this._party_stack.visible_child_name = 'connecting'
            try {
                const party = await this.#client.createParty(name)
                // Now join
                const result = await this.#client.joinParty(party.inviteCode, nickname)
                this.#client.connectWs()
            } catch (e) {
                console.error('[ReadingPartyPanel] Create failed:', e.message)
                this._party_stack.visible_child_name = 'empty'
                const root = this.get_root()
                if (root?.add_toast) {
                    root.add_toast(new Adw.Toast({ title: e.message, timeout: 3 }))
                }
            }
        })

        dialog.present(this.get_root())
    }

    #showJoinDialog() {
        const dialog = new Adw.AlertDialog({
            heading: _('Join Reading Party'),
            body: _('Enter the invite code shared by your friend'),
            close_response: 'cancel',
        })
        dialog.add_response('cancel', _('Cancel'))
        dialog.add_response('join', _('Join'))
        dialog.set_response_appearance('join', Adw.ResponseAppearance.SUGGESTED)

        const group = new Adw.PreferencesGroup()
        const codeRow = new Adw.EntryRow({ title: _('Invite Code') })
        const nicknameRow = new Adw.EntryRow({ title: _('Your Nickname') })
        const serverRow = new Adw.EntryRow({ title: _('Server URL') })
        serverRow.text = this.#client.serverUrl
        nicknameRow.text = this.#client.nickname

        group.add(codeRow)
        group.add(nicknameRow)
        group.add(serverRow)
        dialog.set_extra_child(group)

        dialog.connect('response', async (_, response) => {
            if (response !== 'join') return
            const code = codeRow.text.trim().toUpperCase()
            const nickname = nicknameRow.text.trim()
            const serverUrl = serverRow.text.trim()
            if (!code || !nickname) return

            this.#saveSetting('server-url', serverUrl)
            this._party_stack.visible_child_name = 'connecting'
            try {
                await this.#client.joinParty(code, nickname)
                this.#client.connectWs()
            } catch (e) {
                console.error('[ReadingPartyPanel] Join failed:', e.message)
                this._party_stack.visible_child_name = 'empty'
                const root = this.get_root()
                if (root?.add_toast) {
                    root.add_toast(new Adw.Toast({ title: e.message, timeout: 3 }))
                }
            }
        })

        dialog.present(this.get_root())
    }

    async #leave() {
        await this.#client.leaveParty()
        // Clear UI
        this.#clearMembers()
        this.#clearComments()
        this._party_stack.visible_child_name = 'empty'
    }

    #showConnectedState(state) {
        this._party_name_label.label = state.name || _('Reading Party')
        this._invite_code_label.label = state.inviteCode || ''
        this._party_stack.visible_child_name = 'connected'

        this.#refreshMembers()
        this.#refreshComments(state.comments || [])
    }

    #clearMembers() {
        let child = this._members_list.get_first_child()
        while (child) {
            const next = child.get_next_sibling()
            this._members_list.remove(child)
            child = next
        }
    }

    #refreshMembers() {
        this.#clearMembers()
        const state = this.#client.partyState
        if (!state?.members) return
        const myId = this.#client.memberId
        for (const [id, member] of Object.entries(state.members)) {
            const row = new Adw.ActionRow({
                title: member.nickname + (id === myId ? ` (${_('you')})` : ''),
            })

            // Show progress for current book if available
            if (this.#bookId && member.progress[this.#bookId]) {
                const p = member.progress[this.#bookId]
                const pct = Math.round((p.fraction || 0) * 100)
                const bar = new Gtk.ProgressBar({
                    fraction: p.fraction || 0,
                    valign: Gtk.Align.CENTER,
                    width_request: 80,
                })
                bar.add_css_class('accent')
                row.subtitle = `${pct}%`
                row.add_suffix(bar)

                // Click to navigate
                if (id !== myId && p.cfi) {
                    row.activatable = true
                    row.connect('activated', () => this.emit('go-to-cfi', p.cfi))
                }
            }

            row.add_prefix(new Gtk.Image({ icon_name: 'avatar-default-symbolic' }))
            this._members_list.append(row)
        }
    }

    #clearComments() {
        let child = this._comments_list.get_first_child()
        while (child) {
            const next = child.get_next_sibling()
            this._comments_list.remove(child)
            child = next
        }
    }

    #refreshComments(comments) {
        this.#clearComments()
        for (const comment of comments) {
            this.#addCommentRow(comment)
        }
    }

    #addCommentRow(comment) {
        const row = new Adw.ActionRow({
            title: GLib.markup_escape_text(comment.nickname || '', -1),
            subtitle: GLib.markup_escape_text(comment.text || '', -1),
        })

        const timeLabel = new Gtk.Label({
            label: formatTime(comment.created),
            valign: Gtk.Align.CENTER,
        })
        timeLabel.add_css_class('dim-label')
        timeLabel.add_css_class('caption')
        row.add_suffix(timeLabel)

        if (comment.cfi) {
            row.activatable = true
            row.connect('activated', () => this.emit('go-to-cfi', comment.cfi))
        }

        this._comments_list.append(row)

        // Scroll to bottom
        const adj = this._comments_list.get_parent()?.get_vadjustment?.()
        if (adj) GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            adj.value = adj.upper
            return GLib.SOURCE_REMOVE
        })
    }

    #sendComment() {
        const text = this._comment_entry.text.trim()
        if (!text) return
        this.#client.sendComment(this.#bookId, text, null)
        // Also add locally since server broadcasts to others only
        this.#addCommentRow({
            nickname: this.#client.nickname,
            text,
            created: new Date().toISOString(),
        })
        this._comment_entry.text = ''
    }

    destroy() {
        this.#client.destroy()
    }
})
