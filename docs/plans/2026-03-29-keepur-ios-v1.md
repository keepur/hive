# Keepur iOS v1 Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Build the Keepur iOS app — a native Beekeeper client for chatting with Claude Code on the Mac Mini.

**Architecture:** SwiftUI app with 4 screens (Setup, Chat, Tool Approval, Settings). Connects to the Beekeeper relay via WebSocket (`beekeeper.dodihome.com`). Local message persistence via SwiftData. Auth token in iOS Keychain. Heavy reuse from `dodi-shop-ios` — KeychainManager, WebSocketManager, ChatView patterns all carry over with protocol adaptations.

**Tech Stack:** Swift, SwiftUI, SwiftData, URLSessionWebSocketTask, iOS 17+

**Spec:** `docs/specs/2026-03-29-keepur-ios-v1-design.md`

**Reference codebase:** `~/github/dodi-shop-ios/DodiShop/`

---

### Task 0: Relay protocol update — add `workspaces` to `session_info`

The iOS app needs the workspace list from the server. Add a `workspaces` field to `session_info` messages.

**Files:**
- Modify: `src/beekeeper/types.ts`
- Modify: `src/beekeeper/session-manager.ts`
- Modify: `src/beekeeper/index.ts`

- [ ] **Step 1:** Update `ServerMessage` type to include `workspaces` in `session_info`

In `src/beekeeper/types.ts`, change the `session_info` variant:
```typescript
| { type: "session_info"; sessionId: string; workspace: string; workspaces: string[] }
```

- [ ] **Step 2:** Update `SessionManager` to include workspaces in session_info messages

In `session-manager.ts`, find every place that sends `session_info` and add the workspaces array:
```typescript
this.send({
  type: "session_info",
  sessionId: this.sessionId!,
  workspace: this.workspace,
  workspaces: Object.keys(this.config.workspaces),
});
```

- [ ] **Step 3:** Update `index.ts` connect handler to include workspaces

In the connect handler that sends `session_info` when a session already exists, add `workspaces: Object.keys(config.workspaces)` to the message.

- [ ] **Step 4:** Verify

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 5:** Commit

```bash
git add src/beekeeper/types.ts src/beekeeper/session-manager.ts src/beekeeper/index.ts
git commit -m "feat(beekeeper): add workspaces array to session_info messages"
```

---

### Task 1: Create Xcode project and app entry point

**Files:**
- Create: `~/github/keepur-ios/Keepur/KeepurApp.swift`
- Create: `~/github/keepur-ios/Keepur/Assets.xcassets/` (Xcode generates)

- [ ] **Step 1:** Create the Xcode project

Run:
```bash
mkdir -p ~/github/keepur-ios
cd ~/github/keepur-ios
# Use Xcode CLI or create manually
```

Create the Xcode project with: File > New > Project > App. Settings:
- Product Name: `Keepur`
- Organization: `io.keepur`
- Interface: SwiftUI
- Storage: None (we add SwiftData manually)
- Minimum deployment: iOS 17.0

- [ ] **Step 2:** Replace generated `KeepurApp.swift` with SwiftData setup

Adapted from `dodi-shop-ios/DodiShop/DodiShopApp.swift`:

```swift
import SwiftUI
import SwiftData

@main
struct KeepurApp: App {
    let modelContainer: ModelContainer

    init() {
        do {
            let schema = Schema([Session.self, Message.self])
            let config = ModelConfiguration(schema: schema)
            modelContainer = try ModelContainer(for: schema, configurations: [config])
        } catch {
            let url = URL.applicationSupportDirectory.appending(path: "default.store")
            try? FileManager.default.removeItem(at: url)
            do {
                let schema = Schema([Session.self, Message.self])
                let config = ModelConfiguration(schema: schema)
                modelContainer = try ModelContainer(for: schema, configurations: [config])
            } catch {
                fatalError("Failed to create ModelContainer: \(error)")
            }
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
        .modelContainer(modelContainer)
    }
}
```

- [ ] **Step 3:** Create `.gitignore`

```
# Xcode
build/
DerivedData/
*.xcuserstate
*.xcworkspace/xcuserdata/
*.pbxuser
*.mode1v3
*.mode2v3
*.perspectivev3

# Dependencies
Pods/
.build/
```

- [ ] **Step 4:** Init git repo and commit

```bash
cd ~/github/keepur-ios
git init
git add -A
git commit -m "chore: init Keepur iOS project"
```

---

### Task 2: Data models — Session and Message

Adapted from `dodi-shop-ios/DodiShop/Models/ChatMessage.swift` and `ChatThread.swift`.

**Files:**
- Create: `Keepur/Models/Session.swift`
- Create: `Keepur/Models/Message.swift`

- [ ] **Step 1:** Create `Session.swift`

```swift
import Foundation
import SwiftData

@Model
final class Session {
    @Attribute(.unique) var id: String
    var workspace: String
    var createdAt: Date

    init(id: String, workspace: String, createdAt: Date = .now) {
        self.id = id
        self.workspace = workspace
        self.createdAt = createdAt
    }
}
```

- [ ] **Step 2:** Create `Message.swift`

```swift
import Foundation
import SwiftData

@Model
final class Message {
    @Attribute(.unique) var id: String
    var sessionId: String
    var text: String
    var role: String  // "user", "assistant", "system"
    var timestamp: Date

    init(
        id: String = UUID().uuidString,
        sessionId: String,
        text: String,
        role: String,
        timestamp: Date = .now
    ) {
        self.id = id
        self.sessionId = sessionId
        self.text = text
        self.role = role
        self.timestamp = timestamp
    }
}
```

- [ ] **Step 3:** Commit

```bash
git add Keepur/Models/
git commit -m "feat: add Session and Message SwiftData models"
```

---

### Task 3: WebSocket protocol — WSMessage

Adapted from `dodi-shop-ios/DodiShop/Models/WSMessage.swift`, rewritten for Beekeeper protocol.

**Files:**
- Create: `Keepur/Models/WSMessage.swift`

- [ ] **Step 1:** Create `WSMessage.swift`

```swift
import Foundation

// MARK: - Client → Server

enum WSOutgoing {
    case message(text: String, sessionId: String? = nil)
    case newSession(workspace: String? = nil)
    case approve(toolUseId: String)
    case deny(toolUseId: String)
    case ping

    func encode() throws -> Data {
        let dict: [String: Any]
        switch self {
        case .message(let text, let sessionId):
            var d: [String: Any] = ["type": "message", "text": text]
            if let sessionId { d["sessionId"] = sessionId }
            dict = d
        case .newSession(let workspace):
            var d: [String: Any] = ["type": "new_session"]
            if let workspace { d["workspace"] = workspace }
            dict = d
        case .approve(let toolUseId):
            dict = ["type": "approve", "toolUseId": toolUseId]
        case .deny(let toolUseId):
            dict = ["type": "deny", "toolUseId": toolUseId]
        case .ping:
            dict = ["type": "ping"]
        }
        return try JSONSerialization.data(withJSONObject: dict)
    }
}

// MARK: - Server → Client

enum WSIncoming {
    case message(text: String, sessionId: String, final: Bool)
    case toolApproval(toolUseId: String, tool: String, input: String)
    case status(state: String)  // thinking, idle, tool_running, session_ended
    case sessionInfo(sessionId: String, workspace: String, workspaces: [String])
    case error(message: String)
    case pong

    static func decode(from data: Data) -> WSIncoming? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return nil }

        switch type {
        case "message":
            guard let text = json["text"] as? String,
                  let sessionId = json["sessionId"] as? String,
                  let final = json["final"] as? Bool else { return nil }
            return .message(text: text, sessionId: sessionId, final: final)
        case "tool_approval":
            guard let toolUseId = json["toolUseId"] as? String,
                  let tool = json["tool"] as? String,
                  let input = json["input"] as? String else { return nil }
            return .toolApproval(toolUseId: toolUseId, tool: tool, input: input)
        case "status":
            guard let state = json["state"] as? String else { return nil }
            return .status(state: state)
        case "session_info":
            guard let sessionId = json["sessionId"] as? String,
                  let workspace = json["workspace"] as? String else { return nil }
            let workspaces = json["workspaces"] as? [String] ?? []
            return .sessionInfo(sessionId: sessionId, workspace: workspace, workspaces: workspaces)
        case "error":
            guard let message = json["message"] as? String else { return nil }
            return .error(message: message)
        case "pong":
            return .pong
        default:
            return nil
        }
    }
}
```

- [ ] **Step 2:** Commit

```bash
git add Keepur/Models/WSMessage.swift
git commit -m "feat: add Beekeeper WebSocket protocol types"
```

---

### Task 4: KeychainManager

Lifted directly from `dodi-shop-ios/DodiShop/Managers/KeychainManager.swift`, simplified to token-only.

**Files:**
- Create: `Keepur/Managers/KeychainManager.swift`

- [ ] **Step 1:** Create `KeychainManager.swift`

```swift
import Foundation
import Security

enum KeychainManager {
    private static let service = "io.keepur.beekeeper"
    private static let tokenKey = "auth_token"

    static var token: String? {
        get { read(key: tokenKey) }
        set {
            if let newValue {
                save(key: tokenKey, value: newValue)
            } else {
                delete(key: tokenKey)
            }
        }
    }

    static var hasToken: Bool { token != nil }

    static func clear() { token = nil }

    // MARK: - Private

    private static func save(key: String, value: String) {
        guard let data = value.data(using: .utf8) else { return }
        delete(key: key)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecValueData as String: data
        ]
        SecItemAdd(query as CFDictionary, nil)
    }

    private static func read(key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func delete(key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
        SecItemDelete(query as CFDictionary)
    }
}
```

- [ ] **Step 2:** Commit

```bash
git add Keepur/Managers/KeychainManager.swift
git commit -m "feat: add KeychainManager for Beekeeper auth token"
```

---

### Task 5: WebSocketManager

Adapted from `dodi-shop-ios/DodiShop/Managers/WebSocketManager.swift`. Changed URL, protocol, max reconnect delay.

**Files:**
- Create: `Keepur/Managers/WebSocketManager.swift`

- [ ] **Step 1:** Create `WebSocketManager.swift`

```swift
import Foundation
import Combine

@MainActor
final class WebSocketManager: ObservableObject {
    @Published var isConnected = false

    var onMessage: ((WSIncoming) -> Void)?
    var onAuthFailure: (() -> Void)?

    private var webSocketTask: URLSessionWebSocketTask?
    private var session: URLSession?
    private var pingTimer: Timer?
    private var reconnectAttempts = 0
    private var isReconnecting = false
    private let maxReconnectDelay: TimeInterval = 30
    private let baseURL = "wss://beekeeper.dodihome.com"

    func connect() {
        guard !isConnected else { return }
        guard let token = KeychainManager.token else {
            onAuthFailure?()
            return
        }

        cleanupConnection()

        let url = URL(string: "\(baseURL)?token=\(token)")!
        let config = URLSessionConfiguration.default
        session = URLSession(configuration: config)
        webSocketTask = session?.webSocketTask(with: url)
        webSocketTask?.resume()

        isConnected = true
        reconnectAttempts = 0
        isReconnecting = false
        startPing()
        receiveMessage()
    }

    func disconnect() {
        isReconnecting = false
        pingTimer?.invalidate()
        pingTimer = nil
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
        session?.invalidateAndCancel()
        session = nil
        isConnected = false
    }

    func send(_ outgoing: WSOutgoing) {
        guard isConnected,
              let data = try? outgoing.encode(),
              let string = String(data: data, encoding: .utf8) else { return }
        webSocketTask?.send(.string(string)) { [weak self] error in
            if error != nil {
                Task { @MainActor in
                    self?.handleDisconnect()
                }
            }
        }
    }

    // MARK: - Private

    private func cleanupConnection() {
        pingTimer?.invalidate()
        pingTimer = nil
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        session?.invalidateAndCancel()
        session = nil
        isConnected = false
    }

    private func receiveMessage() {
        webSocketTask?.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .success(let message):
                    switch message {
                    case .string(let text):
                        if let data = text.data(using: .utf8),
                           let incoming = WSIncoming.decode(from: data) {
                            self.onMessage?(incoming)
                        }
                    case .data(let data):
                        if let incoming = WSIncoming.decode(from: data) {
                            self.onMessage?(incoming)
                        }
                    @unknown default:
                        break
                    }
                    self.receiveMessage()
                case .failure(let error):
                    // 401 = auth failure, don't reconnect
                    let nsError = error as NSError
                    if nsError.code == 401 || nsError.code == 1002 {
                        self.isConnected = false
                        self.onAuthFailure?()
                    } else {
                        self.handleDisconnect()
                    }
                }
            }
        }
    }

    private func handleDisconnect() {
        guard isConnected else { return }
        isConnected = false
        pingTimer?.invalidate()
        pingTimer = nil
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard KeychainManager.hasToken, !isReconnecting else { return }
        isReconnecting = true
        reconnectAttempts += 1
        let delay = min(pow(2.0, Double(reconnectAttempts)), maxReconnectDelay)
        Task {
            try? await Task.sleep(for: .seconds(delay))
            guard self.isReconnecting else { return }
            self.isConnected = false
            self.connect()
        }
    }

    private func startPing() {
        pingTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.send(.ping)
            }
        }
    }
}
```

- [ ] **Step 2:** Commit

```bash
git add Keepur/Managers/WebSocketManager.swift
git commit -m "feat: add WebSocketManager for Beekeeper relay"
```

---

### Task 6: ChatViewModel — core orchestration

Adapted from `dodi-shop-ios/DodiShop/ViewModels/ChatViewModel.swift`. Rewritten for Beekeeper protocol: streaming, sessions, tool approval, status.

**Files:**
- Create: `Keepur/ViewModels/ChatViewModel.swift`

- [ ] **Step 1:** Create `ChatViewModel.swift`

```swift
import Foundation
import SwiftData
import SwiftUI

@MainActor
final class ChatViewModel: ObservableObject {
    @Published var messageText = ""
    @Published var currentStatus: String = "idle"  // thinking, tool_running, idle, session_ended
    @Published var currentWorkspace: String = ""
    @Published var availableWorkspaces: [String] = []
    @Published var currentSessionId: String?
    @Published var pendingApproval: ToolApproval?
    @Published var isAuthenticated = true

    let ws = WebSocketManager()
    private var modelContext: ModelContext?
    private var streamingMessageId: String?

    struct ToolApproval: Identifiable {
        let id: String  // toolUseId
        let tool: String
        let input: String
        var remainingSeconds: Int = 60
    }

    func configure(context: ModelContext) {
        self.modelContext = context
        ws.onMessage = { [weak self] incoming in
            self?.handleIncoming(incoming)
        }
        ws.onAuthFailure = { [weak self] in
            self?.isAuthenticated = false
        }
        ws.connect()
    }

    func sendText() {
        let text = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let context = modelContext, let sessionId = currentSessionId else { return }

        let message = Message(sessionId: sessionId, text: text, role: "user")
        context.insert(message)
        try? context.save()

        ws.send(.message(text: text, sessionId: sessionId))
        messageText = ""
    }

    func newSession(workspace: String? = nil) {
        ws.send(.newSession(workspace: workspace))
    }

    func approve(toolUseId: String) {
        ws.send(.approve(toolUseId: toolUseId))
        pendingApproval = nil
    }

    func deny(toolUseId: String) {
        ws.send(.deny(toolUseId: toolUseId))
        pendingApproval = nil
    }

    func clearToken() {
        ws.disconnect()
        KeychainManager.clear()
        isAuthenticated = false
    }

    // MARK: - Private

    private func handleIncoming(_ incoming: WSIncoming) {
        guard let context = modelContext else { return }

        switch incoming {
        case .message(let text, let sessionId, let final):
            handleStreamingMessage(text: text, sessionId: sessionId, final: final, context: context)

        case .toolApproval(let toolUseId, let tool, let input):
            pendingApproval = ToolApproval(id: toolUseId, tool: tool, input: input)

        case .status(let state):
            currentStatus = state
            if state == "session_ended" {
                // Insert divider message
                if let sessionId = currentSessionId {
                    let divider = Message(sessionId: sessionId, text: "Session ended", role: "system")
                    context.insert(divider)
                    try? context.save()
                }
                streamingMessageId = nil
            }

        case .sessionInfo(let sessionId, let workspace, let workspaces):
            // Create new session record if different
            if sessionId != currentSessionId {
                let session = Session(id: sessionId, workspace: workspace)
                context.insert(session)
                try? context.save()
            }
            currentSessionId = sessionId
            currentWorkspace = workspace
            if !workspaces.isEmpty {
                availableWorkspaces = workspaces
            }
            currentStatus = "idle"

        case .error(let message):
            if let sessionId = currentSessionId {
                let msg = Message(sessionId: sessionId, text: "Error: \(message)", role: "system")
                context.insert(msg)
                try? context.save()
            }

        case .pong:
            break
        }
    }

    private func handleStreamingMessage(text: String, sessionId: String, final: Bool, context: ModelContext) {
        if final {
            // Final sentinel — append any remaining text, then stop streaming
            if !text.isEmpty, let existingId = streamingMessageId {
                let descriptor = FetchDescriptor<Message>(
                    predicate: #Predicate { $0.id == existingId }
                )
                if let msg = try? context.fetch(descriptor).first {
                    msg.text += text
                    try? context.save()
                }
            }
            streamingMessageId = nil
            return
        }

        if let existingId = streamingMessageId {
            // Append to existing streaming message
            let descriptor = FetchDescriptor<Message>(
                predicate: #Predicate { $0.id == existingId }
            )
            if let msg = try? context.fetch(descriptor).first {
                msg.text += text
                try? context.save()
            }
        } else {
            // Start new streaming message
            let msg = Message(sessionId: sessionId, text: text, role: "assistant")
            context.insert(msg)
            try? context.save()
            streamingMessageId = msg.id
        }
    }
}
```

- [ ] **Step 2:** Commit

```bash
git add Keepur/ViewModels/ChatViewModel.swift
git commit -m "feat: add ChatViewModel with streaming, sessions, tool approval"
```

---

### Task 7: Views — RootView and SetupView

**Files:**
- Create: `Keepur/Views/RootView.swift`
- Create: `Keepur/Views/SetupView.swift`

- [ ] **Step 1:** Create `RootView.swift`

```swift
import SwiftUI

struct RootView: View {
    @StateObject private var viewModel = ChatViewModel()
    @Environment(\.modelContext) private var modelContext
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if KeychainManager.hasToken && viewModel.isAuthenticated {
                NavigationStack {
                    ChatView(viewModel: viewModel)
                }
            } else {
                SetupView {
                    viewModel.isAuthenticated = true
                    viewModel.configure(context: modelContext)
                }
            }
        }
        .onAppear {
            if KeychainManager.hasToken {
                viewModel.configure(context: modelContext)
            }
        }
        .onChange(of: scenePhase) {
            if scenePhase == .active && KeychainManager.hasToken {
                viewModel.ws.connect()  // Reconnect on foreground
            }
        }
    }
}
```

- [ ] **Step 2:** Create `SetupView.swift`

```swift
import SwiftUI

struct SetupView: View {
    let onConnect: () -> Void

    @State private var token = ""
    @State private var isConnecting = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 32) {
            Spacer()

            // App title
            VStack(spacing: 8) {
                Image(systemName: "server.rack")
                    .font(.system(size: 48))
                    .foregroundStyle(.accent)
                Text("Keepur")
                    .font(.largeTitle.bold())
                Text("Connect to Beekeeper")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            // Token input
            VStack(spacing: 16) {
                SecureField("Beekeeper Token", text: $token)
                    .textFieldStyle(.roundedBorder)
                    .textContentType(.password)
                    .autocorrectionDisabled()
                    .padding(.horizontal, 40)

                if let errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(.red)
                }

                Button {
                    connect()
                } label: {
                    if isConnecting {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    } else {
                        Text("Connect")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .padding(.horizontal, 40)
                .disabled(token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isConnecting)
            }

            Spacer()
            Spacer()
        }
    }

    private func connect() {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        isConnecting = true
        errorMessage = nil
        KeychainManager.token = trimmed
        // Small delay to let WebSocket attempt connection
        Task {
            try? await Task.sleep(for: .seconds(1))
            isConnecting = false
            onConnect()
        }
    }
}
```

- [ ] **Step 3:** Commit

```bash
git add Keepur/Views/RootView.swift Keepur/Views/SetupView.swift
git commit -m "feat: add RootView auth gate and SetupView token entry"
```

---

### Task 8: Views — ChatView and MessageBubble

The main screen. Adapted from `dodi-shop-ios` ChatView — stripped shop-floor UX (camera, photos, voice, language), added status indicator and workspace badge.

**Files:**
- Create: `Keepur/Views/ChatView.swift`
- Create: `Keepur/Views/MessageBubble.swift`

- [ ] **Step 1:** Create `ChatView.swift`

```swift
import SwiftUI
import SwiftData

struct ChatView: View {
    @ObservedObject var viewModel: ChatViewModel
    @Environment(\.modelContext) private var modelContext
    @Query private var messages: [Message]
    @State private var showSettings = false

    // Note: @Query loads all messages, filtered client-side by sessionId.
    // Acceptable for v1 single-user volume. If performance degrades, switch to
    // modelContext.fetch() with dynamic predicate in ViewModel.

    init(viewModel: ChatViewModel) {
        self.viewModel = viewModel
        _messages = Query(sort: \Message.timestamp)
    }

    private var sessionMessages: [Message] {
        guard let sessionId = viewModel.currentSessionId else { return [] }
        return messages.filter { $0.sessionId == sessionId }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Messages
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(sessionMessages, id: \.id) { message in
                            MessageBubble(message: message)
                                .id(message.id)
                        }

                        if viewModel.currentStatus == "thinking" || viewModel.currentStatus == "tool_running" {
                            StatusIndicator(status: viewModel.currentStatus)
                                .id("status")
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
                .onChange(of: sessionMessages.count) {
                    withAnimation {
                        proxy.scrollTo(sessionMessages.last?.id ?? "status", anchor: .bottom)
                    }
                }
                .onChange(of: viewModel.currentStatus) {
                    if viewModel.currentStatus == "thinking" || viewModel.currentStatus == "tool_running" {
                        withAnimation {
                            proxy.scrollTo("status", anchor: .bottom)
                        }
                    }
                }
            }

            Divider()

            // Input bar
            inputBar
        }
        .navigationTitle(viewModel.currentWorkspace.isEmpty ? "Keepur" : viewModel.currentWorkspace)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                // Connection status
                Circle()
                    .fill(viewModel.ws.isConnected ? .green : .red)
                    .frame(width: 8, height: 8)
            }
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: 12) {
                    Button {
                        viewModel.newSession()
                    } label: {
                        Image(systemName: "plus.message")
                    }

                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                }
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView(viewModel: viewModel)
        }
        .sheet(item: $viewModel.pendingApproval) { approval in
            ToolApprovalView(
                approval: approval,
                onApprove: { viewModel.approve(toolUseId: approval.id) },
                onDeny: { viewModel.deny(toolUseId: approval.id) }
            )
            .interactiveDismissDisabled()
        }
    }

    // MARK: - Input Bar

    private var inputBar: some View {
        HStack(spacing: 12) {
            TextField("Message...", text: $viewModel.messageText, axis: .vertical)
                .textFieldStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 20)
                        .fill(.ultraThinMaterial)
                )
                .lineLimit(1...6)
                .onSubmit { viewModel.sendText() }

            Button { viewModel.sendText() } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(
                        viewModel.messageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            ? Color.gray.opacity(0.3) : Color.accentColor
                    )
            }
            .disabled(
                viewModel.messageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || viewModel.currentSessionId == nil
                || viewModel.currentStatus == "session_ended"
            )
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial)
    }
}

// MARK: - Status Indicator

struct StatusIndicator: View {
    let status: String
    @State private var phase = 0.0

    var body: some View {
        HStack {
            HStack(spacing: 6) {
                if status == "thinking" {
                    ForEach(0..<3, id: \.self) { i in
                        Circle()
                            .fill(.secondary)
                            .frame(width: 8, height: 8)
                            .offset(y: sin(phase + Double(i) * 0.8) * 4)
                    }
                } else {
                    Image(systemName: "hammer.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("Running tool...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: 18)
                    .fill(Color(.systemGray5))
            )
            Spacer()
        }
        .onAppear {
            if status == "thinking" {
                withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) {
                    phase = .pi
                }
            }
        }
    }
}
```

- [ ] **Step 2:** Create `MessageBubble.swift`

```swift
import SwiftUI

struct MessageBubble: View {
    let message: Message

    var body: some View {
        switch message.role {
        case "user":
            userBubble
        case "system":
            systemBubble
        default:
            assistantBubble
        }
    }

    private var userBubble: some View {
        HStack {
            Spacer(minLength: 60)
            VStack(alignment: .trailing, spacing: 4) {
                Text(message.text)
                    .font(.body)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: 18)
                            .fill(Color.accentColor)
                    )
                    .foregroundStyle(.white)

                Text(message.timestamp, style: .time)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private var assistantBubble: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                // Basic markdown via LocalizedStringKey. For full code block rendering
                // with copy buttons, add swift-markdown-ui package in a follow-up.
                Text(LocalizedStringKey(message.text))
                    .font(.body)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: 18)
                            .fill(Color(.systemGray5))
                    )

                Text(message.timestamp, style: .time)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Spacer(minLength: 60)
        }
    }

    private var systemBubble: some View {
        HStack {
            Spacer()
            Text(message.text)
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.vertical, 8)
            Spacer()
        }
    }
}
```

- [ ] **Step 3:** Commit

```bash
git add Keepur/Views/ChatView.swift Keepur/Views/MessageBubble.swift
git commit -m "feat: add ChatView with streaming display and MessageBubble"
```

---

### Task 9: Views — ToolApprovalView and SettingsView

**Files:**
- Create: `Keepur/Views/ToolApprovalView.swift`
- Create: `Keepur/Views/SettingsView.swift`

- [ ] **Step 1:** Create `ToolApprovalView.swift`

```swift
import SwiftUI

struct ToolApprovalView: View {
    let approval: ChatViewModel.ToolApproval
    let onApprove: () -> Void
    let onDeny: () -> Void

    @State private var remainingSeconds = 60
    @Environment(\.dismiss) private var dismiss

    let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            // Icon
            Image(systemName: "exclamationmark.shield.fill")
                .font(.system(size: 48))
                .foregroundStyle(.orange)

            // Title
            Text("Approval Required")
                .font(.title2.bold())

            // Details
            VStack(spacing: 8) {
                Text("Tool: \(approval.tool)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                Text(approval.input)
                    .font(.system(.body, design: .monospaced))
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: 8)
                            .fill(Color(.systemGray6))
                    )
            }
            .padding(.horizontal, 24)

            // Countdown
            Text("Auto-deny in \(remainingSeconds)s")
                .font(.caption)
                .foregroundStyle(.secondary)

            // Buttons
            HStack(spacing: 16) {
                Button {
                    onDeny()
                } label: {
                    Text("Deny")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(.red)

                Button {
                    onApprove()
                } label: {
                    Text("Approve")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(.green)
            }
            .padding(.horizontal, 24)

            Spacer()
        }
        .onReceive(timer) { _ in
            if remainingSeconds > 0 {
                remainingSeconds -= 1
            } else {
                onDeny()
                // Sheet auto-dismisses when pendingApproval becomes nil
            }
        }
        .presentationDetents([.medium])
    }
}
```

- [ ] **Step 2:** Create `SettingsView.swift`

```swift
import SwiftUI

struct SettingsView: View {
    @ObservedObject var viewModel: ChatViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                // Connection
                Section("Connection") {
                    HStack {
                        Text("Status")
                        Spacer()
                        HStack(spacing: 6) {
                            Circle()
                                .fill(viewModel.ws.isConnected ? .green : .red)
                                .frame(width: 8, height: 8)
                            Text(viewModel.ws.isConnected ? "Connected" : "Disconnected")
                                .foregroundStyle(.secondary)
                        }
                    }

                    if let sessionId = viewModel.currentSessionId {
                        HStack {
                            Text("Session")
                            Spacer()
                            Text(String(sessionId.prefix(8)))
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                // Workspaces
                if !viewModel.availableWorkspaces.isEmpty {
                    Section("Workspace") {
                        ForEach(viewModel.availableWorkspaces, id: \.self) { workspace in
                            Button {
                                viewModel.newSession(workspace: workspace)
                                dismiss()
                            } label: {
                                HStack {
                                    Text(workspace)
                                    Spacer()
                                    if workspace == viewModel.currentWorkspace {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(.accent)
                                    }
                                }
                            }
                            .foregroundStyle(.primary)
                        }
                    }
                }

                // Connection controls
                Section {
                    Button(viewModel.ws.isConnected ? "Disconnect" : "Reconnect") {
                        if viewModel.ws.isConnected {
                            viewModel.ws.disconnect()
                        } else {
                            viewModel.ws.connect()
                        }
                    }

                    Button("Clear Token & Disconnect", role: .destructive) {
                        viewModel.clearToken()
                        dismiss()
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
```

- [ ] **Step 3:** Commit

```bash
git add Keepur/Views/ToolApprovalView.swift Keepur/Views/SettingsView.swift
git commit -m "feat: add ToolApprovalView and SettingsView"
```

---

### Task 10: Create GitHub repo and push

- [ ] **Step 1:** Create repo

```bash
cd ~/github/keepur-ios
gh repo create dodi-hq/keepur-ios --private --source=. --push
```

- [ ] **Step 2:** Verify build in Xcode

Open `Keepur.xcodeproj`, build for iOS Simulator (Cmd+B). Fix any compilation errors.

- [ ] **Step 3:** Add CLAUDE.md

Create `CLAUDE.md` with project overview, architecture, build instructions, and conventions matching the dodi-shop-ios pattern.

- [ ] **Step 4:** Commit and push

```bash
git add CLAUDE.md
git commit -m "docs: add CLAUDE.md"
git push
```

---

## Task Summary

| Task | What | Reuse from dodi-shop |
|------|------|---------------------|
| 0 | Relay protocol update (workspaces) | — |
| 1 | Xcode project + app entry | `DodiShopApp.swift` pattern |
| 2 | Data models (Session, Message) | `ChatMessage.swift`, `ChatThread.swift` |
| 3 | WebSocket protocol types | `WSMessage.swift` (rewritten for Beekeeper) |
| 4 | KeychainManager | `KeychainManager.swift` (nearly verbatim) |
| 5 | WebSocketManager | `WebSocketManager.swift` (URL + auth failure) |
| 6 | ChatViewModel | `ChatViewModel.swift` (rewritten for streaming/sessions) |
| 7 | RootView + SetupView | `RootView.swift` pattern |
| 8 | ChatView + MessageBubble | `ChatView.swift` (stripped shop UX) |
| 9 | ToolApprovalView + SettingsView | New |
| 10 | GitHub repo + CLAUDE.md | — |
