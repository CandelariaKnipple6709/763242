import SwiftUI

struct ContentView: View {
    @StateObject private var store = WebViewStore()

    @AppStorage("camswap.startURL") private var startURL: String = "https://your-streaming-service.example.com"
    @AppStorage("camswap.serverUrl") private var serverUrl: String = "wss://your-signaling-server.example.com"
    @AppStorage("camswap.room") private var room: String = "stream-1234"
    @AppStorage("camswap.showBadge") private var showBadge: Bool = true

    @State private var showSettings: Bool = false
    @State private var showScanner: Bool = false
    /// What's typed in the bottom address bar. Starts from the saved
    /// start URL, then stays in sync with in-page navigation via
    /// store.currentURLString (see .onChange below).
    @State private var addressBarText: String = ""
    @FocusState private var addressBarFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            if showSettings {
                settingsPanel
                    .padding(12)
                    .background(Color(.secondarySystemBackground))
                Divider()
            }

            // Top status strip: settings, back, reload, camswap status.
            HStack(spacing: 8) {
                Button {
                    withAnimation { showSettings.toggle() }
                } label: {
                    Image(systemName: "gearshape")
                }

                Button {
                    showScanner = true
                } label: {
                    Image(systemName: "qrcode.viewfinder")
                }

                Button {
                    store.webView.goBack()
                } label: {
                    Image(systemName: "chevron.left")
                }
                .disabled(!store.webView.canGoBack)

                Button {
                    store.reload()
                } label: {
                    Image(systemName: store.isLoading ? "xmark" : "arrow.clockwise")
                }

                Text(store.statusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)

            Divider()

            WebViewRepresentable(webView: store.webView)

            Divider()

            // Bottom address bar — behaves like a normal mobile browser's:
            // always visible, shows the current page's URL, editable, and
            // navigates on submit.
            addressBar
        }
        .onAppear {
            addressBarText = startURL
            applySettingsAndLoad(urlString: startURL)
        }
        .onChange(of: store.currentURLString) { newValue in
            // Don't fight the user while they're actively editing the field.
            if !addressBarFocused, !newValue.isEmpty {
                addressBarText = newValue
            }
        }
        .fullScreenCover(isPresented: $showScanner) {
            QRScannerView(
                onScan: { server, room in
                    serverUrl = server
                    self.room = room
                    showScanner = false
                    // Re-apply immediately against whatever page is already
                    // loaded, so scanning the QR is the only step needed.
                    applySettingsAndLoad(urlString: addressBarText.isEmpty ? startURL : addressBarText)
                },
                onCancel: { showScanner = false }
            )
            .ignoresSafeArea()
        }
    }

    private var addressBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "lock.fill")
                .font(.caption)
                .foregroundStyle(.secondary)

            TextField("Адрес сайта", text: $addressBarText)
                .textFieldStyle(.plain)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .disableAutocorrection(true)
                .focused($addressBarFocused)
                .submitLabel(.go)
                .onSubmit { navigateToAddressBar() }

            if !addressBarText.isEmpty {
                Button {
                    addressBarText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
            }

            Button {
                navigateToAddressBar()
            } label: {
                Text("Перейти")
                    .font(.subheadline.weight(.semibold))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color(.secondarySystemBackground))
    }

    private var settingsPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Настройка подмены камеры")
                .font(.headline)

            labeledField("Signaling server (wss://...)", text: $serverUrl)
            labeledField("Код комнаты", text: $room)

            Toggle("Показывать статус-бейдж (для отладки)", isOn: $showBadge)

            Button {
                applySettingsAndLoad(urlString: addressBarText.isEmpty ? startURL : addressBarText)
                withAnimation { showSettings = false }
            } label: {
                Text("Применить")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private func labeledField(_ label: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            TextField(label, text: text)
                .textFieldStyle(.roundedBorder)
                .autocapitalization(.none)
                .disableAutocorrection(true)
        }
    }

    private func navigateToAddressBar() {
        addressBarFocused = false
        let target = addressBarText
        startURL = target // remember as the default for next app launch
        applySettingsAndLoad(urlString: target)
    }

    /// Re-applies the camswap config (server/room/badge) and loads the
    /// given URL. Config changes always require a reload since injected
    /// user scripts can't be hot-swapped into an already-running page.
    private func applySettingsAndLoad(urlString: String) {
        store.applyCamswapConfig(
            serverUrl: serverUrl,
            room: room,
            showStatusBadge: showBadge
        )
        store.load(urlString: urlString)
    }
}

#Preview {
    ContentView()
}
