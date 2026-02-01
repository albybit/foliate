# Reading Party Feature - Implementation Plan

## What This Is

This document describes a new feature for **Foliate**, a GTK4/GJS e-book reader. The feature is called **Reading Party** - it lets users create or join a shared reading session with friends. Within a party, everyone's reading progress, annotations/highlights, and comments are shared in real time via WebSocket.

**Branch:** Create `reading-party` from `gtk4` (`git checkout -b reading-party`).

---

## Existing Codebase Context

### Technology Stack
- **GJS** (>= 1.76) - GNOME JavaScript runtime
- **GTK4** (>= 4.12) + **Libadwaita** (>= 1.7) - UI toolkit
- **WebKitGTK 6.0** - renders book content in a WebView
- **Meson** - build system
- **GObject** - class system with signals and properties

### Key Architecture
- Entry point: `src/main.js` -> `src/app.js` (Application class)
- Application window (`src/app.js` ApplicationWindow) holds a stack switching between `Library` and `BookViewer`
- `src/book-viewer.js` - main reading interface with sidebar, navbar, WebView
- `src/data.js` - `BookData` and `BookDataStore` classes manage per-book data
- `src/annotations.js` - annotation/bookmark data models and UI widgets
- `src/utils.js` - utilities including `JSONStorage`, `makeDataClass`, `debounce`, `connect`, `bindSettings`, `settings`
- `src/webview.js` - WebView wrapper with bidirectional JS communication
- `src/selection-tools.js` - dictionary, Wikipedia, translate, AI assistant tools
- `src/reader/reader.js` - runs inside WebKit, handles book rendering

### Data Storage
- **Per-book JSON files** in `~/.local/share/com.github.johnfactotum.Foliate/<encoded-key>.json`:
  ```json
  { "lastLocation": "epubcfi(...)", "bookmarks": ["epubcfi(...)"], "annotations": [...] }
  ```
- **JSONStorage class** (`src/utils.js`): GObject class with debounced writes (1000ms), file monitoring, `get()`/`set()` methods, `modified`/`externally-modified` signals
- **GSettings** (`data/com.github.johnfactotum.Foliate.gschema.xml`): app-wide preferences stored via dconf

### Annotation Data Model (`src/annotations.js`)
```javascript
Annotation { value: string (EPUB CFI), color: string, text: string, note: string, created: string, modified: string }
Bookmark { value: string (CFI), label: string }
```
Created via `utils.makeDataClass()`. Stored in `AnnotationModel` (extends `Gio.ListStore`, hierarchical by chapter).

### Sidebar Structure (`src/ui/book-viewer.ui`)
The sidebar uses `AdwViewStack` (`contents-stack`) with 3 tabs:
1. **Contents** (TOC) - `view-list-symbolic`
2. **Annotations** - `document-edit-symbolic`
3. **Bookmarks** - `user-bookmarks-symbolic`

Tab switching via `AdwInlineViewSwitcher`. Each tab has a `GtkStack` for empty/populated states.

### UI Conventions
- XML-based UI definitions in `src/ui/*.ui`
- GObject classes registered with `GObject.registerClass({ GTypeName: 'Foliate...', Template: pkg.moduleuri('ui/...'), InternalChildren: [...] })`
- Settings bound via `utils.bindSettings('viewer', this, ['prop-name'])`
- Actions via `utils.addMethods(this, { actions: [...] })`
- List views: `Gio.ListStore` + `Gtk.ListView` + `Gtk.SignalListItemFactory` (setup/bind pattern)
- i18n: `import { gettext as _ } from 'gettext'`

### Networking
- All current networking uses WebKit's `fetch()` API from within HTML/JS (OPDS catalogs, AI assistant API calls)
- No existing libsoup usage for HTTP/WebSocket in the GJS layer
- libsoup 3.0 is available as a transitive dependency of WebKitGTK 6.0

### Build System
- `meson.build` at root, `src/meson.build`, `data/meson.build`
- Resources bundled via `src/gresource.xml` -> compiled with `gnome.compile_resources()`
- GSettings schema installed from `data/com.github.johnfactotum.Foliate.gschema.xml`
- Build: `meson setup builddir && ninja -C builddir`
- Run: `./builddir/src/foliate`

### Recent Feature Example: AI Assistant (commit 4f90090)
This is the pattern to follow for adding new settings and features:
1. Add keys to `gschema.xml` under the `viewer` schema
2. Add GObject properties to relevant class via `utils.makeParams()`
3. Bind settings with `utils.bindSettings('viewer', this, [...])`
4. Add UI widgets in the `ViewPreferencesWindow` section of `src/ui/view-preferences-window.ui`
5. Wire bindings in `src/book-viewer.js` constructor

---

## Feature Requirements

1. **Server-mediated**: Node.js + Express + ws (WebSocket library), runs in `server/` directory (monorepo)
2. **Identity**: Nicknames only, no accounts or authentication
3. **Scope**: One party can have multiple books
4. **Sharing**: Automatic - all progress, annotations, highlights, comments are shared
5. **Persistence**: Party state survives app and server restarts
6. **Containerized**: Server runs in Docker for easy deployment

---

## Data Model

### Server Storage (`$DATA_DIR/parties/<partyId>.json`)
```json
{
  "id": "abc123",
  "name": "Moby Dick Book Club",
  "inviteCode": "WHALE42",
  "created": "2026-01-15T10:00:00Z",
  "books": ["foliate:<md5>"],
  "members": {
    "member-uuid-1": {
      "nickname": "Alice",
      "joinedAt": "2026-01-15T10:01:00Z",
      "progress": {
        "foliate:<md5>": { "cfi": "epubcfi(...)", "fraction": 0.42, "updatedAt": "..." }
      }
    }
  },
  "annotations": [
    { "id": "ann-uuid", "bookId": "foliate:<md5>", "memberId": "member-uuid-1",
      "nickname": "Alice", "value": "epubcfi(...)", "color": "aqua",
      "text": "highlighted text", "note": "my note",
      "created": "2026-01-15T11:00:00Z", "modified": "2026-01-15T11:05:00Z" }
  ],
  "comments": [
    { "id": "cmt-uuid", "bookId": "foliate:<md5>", "memberId": "member-uuid-1",
      "nickname": "Alice", "text": "Great chapter!",
      "cfi": "epubcfi(...)", "created": "2026-01-15T11:30:00Z" }
  ]
}
```

### WebSocket Message Protocol

All messages are JSON with a `type` field:

| Direction | Type | Payload |
|---|---|---|
| Client -> Server | `join` | `{ partyId, memberId, nickname }` |
| Client -> Server | `progress` | `{ bookId, cfi, fraction }` |
| Client -> Server | `annotation` | `{ bookId, annotation }` |
| Client -> Server | `delete-annotation` | `{ bookId, annotationId }` |
| Client -> Server | `comment` | `{ bookId, text, cfi }` |
| Server -> Client | `state` | Full party state (sent on join) |
| Server -> Client | `member-joined` | `{ memberId, nickname }` |
| Server -> Client | `member-left` | `{ memberId }` |
| Server -> Client | `progress` | `{ memberId, nickname, bookId, cfi, fraction }` |
| Server -> Client | `annotation` | `{ memberId, nickname, bookId, annotation }` |
| Server -> Client | `delete-annotation` | `{ bookId, annotationId }` |
| Server -> Client | `comment` | `{ memberId, nickname, bookId, comment }` |

---

## Implementation Phases

Each phase is self-contained and independently testable.

---

### Phase 1: Server Foundation

Build the server as a standalone service testable with curl and wscat.

**New files:**
- `server/package.json` - deps: express, ws, uuid
- `server/index.js` - HTTP server + Express + ws WebSocket server. Config via env vars:
  - `PORT` (default 3000)
  - `DATA_DIR` (default `./data`)
  - `HOST` (default `0.0.0.0`)
- `server/storage.js` - file-based JSON storage with debounced writes (2s) under `$DATA_DIR/parties/`
- `server/routes.js` - REST API:
  - `POST /api/parties` - create party (generates 6-char uppercase alphanumeric invite code)
  - `POST /api/parties/join` - join by `{ inviteCode, nickname }`, returns `{ partyId, memberId, party }`
  - `GET /api/parties/:id` - get full party state
  - `DELETE /api/parties/:id/members/:memberId` - leave party
- `server/ws-handler.js` - WebSocket connection handler:
  - Authenticate by `partyId` + `memberId` query params on connect
  - Route messages by `type` field
  - Broadcast to all other members of the same party
  - Persist state changes to storage
- `server/.gitignore` - ignore `node_modules/`, `data/`

**Test:**
```bash
cd server && npm install && node index.js
# Create party
curl -X POST http://localhost:3000/api/parties -H 'Content-Type: application/json' -d '{"name":"Test"}'
# Join party
curl -X POST http://localhost:3000/api/parties/join -H 'Content-Type: application/json' -d '{"inviteCode":"<CODE>","nickname":"Alice"}'
# WebSocket test with wscat (npm i -g wscat)
wscat -c 'ws://localhost:3000/ws?partyId=<ID>&memberId=<MID>'
# Send: {"type":"join","partyId":"...","memberId":"...","nickname":"Alice"}
# Receive: {"type":"state",...}
# Open second wscat, verify messages broadcast between them
# Check server/data/parties/<id>.json exists on disk
```

---

### Phase 2: Client Connection Layer

GJS module for WebSocket + REST communication with the server.

**New files:**
- `src/reading-party.js` - `ReadingPartyClient` GObject class

**Modified files:**
- `data/com.github.johnfactotum.Foliate.gschema.xml` - add child schema `reading-party` under `viewer`:
  ```xml
  <key name="server-url" type="s"><default>'http://localhost:3000'</default></key>
  <key name="nickname" type="s"><default>''</default></key>
  <key name="member-id" type="s"><default>''</default></key>
  <key name="party-id" type="s"><default>''</default></key>
  <key name="auto-connect" type="b"><default>false</default></key>
  ```
- `src/gresource.xml` - register `reading-party.js`

**Implementation notes for `ReadingPartyClient`:**
- Use `Soup.Session` from `gi://Soup?version=3.0` (libsoup 3.0)
- WebSocket: `session.websocket_connect_async(message, null, null, priority, null, callback)` -> returns `Soup.WebsocketConnection`
- `Soup.WebsocketConnection` signals: `message` (type, data), `closed`, `error`
- Send: `connection.send_text(JSON.stringify(msg))`
- REST: `Soup.Message.new('POST', url)` + `message.set_request_body_from_bytes()` + `session.send_and_read_async()`
- Register as GObject class with signals: `connected`, `disconnected`, `state-updated`, `member-joined`, `member-left`, `progress-updated`, `annotation-received`, `annotation-deleted`, `comment-received`, `error`
- Methods: `createParty(name)`, `joinParty(inviteCode, nickname)`, `leaveParty()`, `connectWs()`, `disconnect()`, `sendProgress(bookId, cfi, fraction)`, `sendAnnotation(bookId, annotation)`, `deleteAnnotation(bookId, annotationId)`, `sendComment(bookId, text, cfi)`
- Debounce `sendProgress` at 500ms via `utils.debounce()`

**Test:** Add temporary test code in `book-viewer.js` constructor to instantiate `ReadingPartyClient`, call `createParty()`, connect, and log signals. Verify with wscat on the other end.

---

### Phase 3: Party Management UI

Add a 4th "Reading Party" tab to the sidebar with create/join/leave functionality.

**New files:**
- `src/ui/reading-party.ui` - party panel with `GtkStack`:
  - `empty` state: `AdwStatusPage` with `system-users-symbolic` icon, "No Reading Party" title, Create and Join buttons
  - `connected` state: party name label, invite code with copy button, `Gtk.ListView` of members, Leave button
- `src/ui/reading-party-row.ui` - member row: nickname `GtkLabel` + `GtkProgressBar`

**Modified files:**
- `src/ui/book-viewer.ui` - add 4th `AdwViewStackPage` to `contents-stack`:
  ```xml
  <child>
    <object class="AdwViewStackPage">
      <property name="name">party</property>
      <property name="title" translatable="yes">Reading Party</property>
      <property name="icon-name">system-users-symbolic</property>
      <property name="child">
        <object class="GtkStack" id="party-stack">...</object>
      </property>
    </object>
  </child>
  ```
- `src/book-viewer.js` - add `party-stack` etc to `InternalChildren`, wire buttons to `ReadingPartyClient`, add server URL + nickname entries to `ViewPreferencesWindow` (follow AI assistant settings pattern)
- `src/gresource.xml` - register new UI files

**Dialogs:** `Adw.AlertDialog` with `AdwEntryRow` for create (party name) and join (invite code).

**Test:** Build, run Foliate, open a book. Sidebar should show 4 tabs. Click "Reading Party" tab. Create a party, see invite code. Open second Foliate instance, join with invite code. Both should show each other in member list. Leave party returns to empty state.

---

### Phase 4: Progress Sync

Share reading progress in real time.

**Modified files:**
- `src/book-viewer.js` - in `#onRelocate()` (the callback that fires on page changes, around line 868), after saving `lastLocation` to local storage, call `partyClient.sendProgress(bookId, cfi, fraction)` if connected
- `src/reading-party.js` - handle incoming `progress` messages, update member data in `Gio.ListStore`, which triggers UI refresh

**Display:** Each member row shows nickname + percentage + `GtkProgressBar`. Clicking a member navigates to their position via `this._view.goTo(cfi)`.

**Test:** Two instances in same party, same book. Turn pages in one, see progress update in the other within ~1 second.

---

### Phase 5: Annotation/Highlight Sync

Share annotations with visual distinction between own and others'.

**Modified files:**
- `src/data.js` - after `#saveAnnotations()` in `BookData`, emit a signal or callback so the party client can send the annotation
- `src/book-viewer.js` - on receiving party annotations, render via `view.addAnnotation()` with distinct styling; on section change re-render
- `src/reading-party.js` - handle `annotation`/`delete-annotation` messages, maintain party annotations array
- `src/annotations.js` - add `PartyAnnotationRow` with nickname badge, `editable=false`

**Visual distinction:** Party annotations use different color palette (pastel/lighter) or dashed underline style. Nickname shown near highlight. They are in-memory only on the client (not saved to local JSONStorage).

**Test:** Two instances, same book. Create highlight in one, see it appear in the other with author name. Delete it, see it disappear. Local annotations remain editable and separate.

---

### Phase 6: Comments System

Text comments anchored to book positions.

**New files:**
- `src/ui/reading-party-comment.ui` - comment row: nickname, text, timestamp, clickable location

**Modified files:**
- `src/reading-party.js` - handle `comment` messages, maintain comments array
- `src/ui/reading-party.ui` - add comments section below member list with `GtkEntry` + send button

**Test:** Two instances. Post comment, see it appear in other instance with nickname and timestamp. Click comment to navigate to location. Rejoin party after restart - comments persist.

---

### Phase 7: Polish & Edge Cases

**Modified files:**
- `src/reading-party.js` - auto-reconnect with exponential backoff (1s, 2s, 4s... max 30s using `GLib.timeout_add`), auto-connect on book open if `auto-connect` setting is true
- `src/book-viewer.js` - connection status indicator in party panel, cleanup in `vfunc_unroot()`
- `src/app.js` - global CSS for party styling

**Edge cases:**
- Multiple books per party: `bookId` field in all messages
- Offline members: show last known progress + "last seen" time
- App restart: reconnect and re-fetch full state via `state` message
- Conflict: annotations are additive, no merge conflicts needed

**Test:** Kill server while connected -> reconnects automatically. Close/reopen Foliate -> auto-rejoins. Connection indicator reflects state.

---

### Phase 8: Containerization

Package the server for Docker deployment.

**New files:**
- `server/Dockerfile`:
  ```dockerfile
  FROM node:22-alpine
  WORKDIR /app
  COPY package*.json ./
  RUN npm ci --production
  COPY . .
  RUN mkdir -p /data
  ENV PORT=3000 DATA_DIR=/data HOST=0.0.0.0
  EXPOSE 3000
  VOLUME /data
  CMD ["node", "index.js"]
  ```
- `server/docker-compose.yml`:
  ```yaml
  services:
    reading-party:
      build: .
      ports:
        - "3000:3000"
      volumes:
        - party-data:/data
      restart: unless-stopped
  volumes:
    party-data:
  ```
- `server/.dockerignore` - ignore `node_modules/`, `data/`, `.git`

No server code changes needed - Phase 1 already uses env vars for config.

**Test:**
```bash
cd server && docker compose up -d
curl http://localhost:3000/api/parties  # verify running
# Run full create/join test against container
docker compose down && docker compose up -d
curl http://localhost:3000/api/parties/<id>  # verify data persisted
```

---

## File Summary

| Phase | New Files | Modified Files |
|---|---|---|
| 1 | `server/package.json`, `server/index.js`, `server/storage.js`, `server/routes.js`, `server/ws-handler.js`, `server/.gitignore` | - |
| 2 | `src/reading-party.js` | `data/com.github.johnfactotum.Foliate.gschema.xml`, `src/gresource.xml` |
| 3 | `src/ui/reading-party.ui`, `src/ui/reading-party-row.ui` | `src/ui/book-viewer.ui`, `src/book-viewer.js`, `src/gresource.xml` |
| 4 | - | `src/book-viewer.js`, `src/reading-party.js` |
| 5 | - | `src/data.js`, `src/book-viewer.js`, `src/reading-party.js`, `src/annotations.js` |
| 6 | `src/ui/reading-party-comment.ui` | `src/reading-party.js`, `src/ui/reading-party.ui` |
| 7 | - | `src/reading-party.js`, `src/book-viewer.js`, `src/app.js` |
| 8 | `server/Dockerfile`, `server/docker-compose.yml`, `server/.dockerignore` | - |

## Critical Files Reference

These are the most important existing files to read before implementing:

- `src/book-viewer.js` - main integration point (sidebar, actions, WebView, settings window, `#onRelocate`)
- `src/data.js` - BookData class (annotation CRUD, storage lifecycle)
- `src/annotations.js` - AnnotationModel, AnnotationRow, BookmarkModel (data model patterns)
- `src/utils.js` - JSONStorage, makeDataClass, debounce, connect, bindSettings, settings, makeParams
- `src/ui/book-viewer.ui` - sidebar layout with AdwViewStack contents-stack
- `src/ui/view-preferences-window.ui` - settings UI (follow this pattern for party settings)
- `data/com.github.johnfactotum.Foliate.gschema.xml` - GSettings schema
- `src/gresource.xml` - resource registration
- `src/selection-tools.js` - example of how AI assistant settings were added (recent feature, good pattern to follow)
