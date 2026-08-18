import Foundation
import WebKit
import Combine

/// Owns a single WKWebView instance and knows how to (re)inject the
/// camswap camera-substitution script into it. Recreating the user
/// scripts requires touching WKUserContentController + reloading —
/// there is no way to hot-swap an already-running page's overridden
/// getUserMedia, so changing server/room/etc. always triggers a reload.
final class WebViewStore: NSObject, ObservableObject, WKNavigationDelegate {

    @Published var isLoading: Bool = false
    @Published var currentURLString: String = ""
    @Published var statusText: String = "не настроено"

    let webView: WKWebView

    override init() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        // Empty set = no user gesture required before media (incl. our
        // injected hidden <video> and any autoplay the target site does)
        // can start playing.
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsPictureInPictureMediaPlayback = false

        webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = true

        super.init()
        webView.navigationDelegate = self
    }

    /// Rebuilds the injected script set from the embedded camswap script
    /// (see CamswapScript.swift) plus a small config header, then reloads
    /// the page so the substitution takes effect from document-start again.
    func applyCamswapConfig(
        serverUrl: String,
        room: String,
        videoWidth: Int = 1280,
        videoHeight: Int = 720,
        fps: Int = 30,
        showStatusBadge: Bool = true
    ) {
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()

        let configJSON = """
        window.__CAMSWAP_CONFIG__ = {
          serverUrl: \(jsString(serverUrl)),
          room: \(jsString(room)),
          videoWidth: \(videoWidth),
          videoHeight: \(videoHeight),
          fps: \(fps),
          showStatusBadge: \(showStatusBadge ? "true" : "false")
        };
        """
        let configScript = WKUserScript(
            source: configJSON,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        )
        controller.addUserScript(configScript)

        guard let camswapSource = CamswapScript.source else {
            statusText = "ОШИБКА: не удалось декодировать встроенный camswap.js"
            return
        }
        let mainScript = WKUserScript(
            source: camswapSource,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        )
        controller.addUserScript(mainScript)

        statusText = "конфигурация применена (комната: \(room))"
    }

    func load(urlString: String) {
        var s = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.contains("://") {
            s = "https://" + s
        }
        guard let url = URL(string: s) else {
            statusText = "некорректный URL: \(urlString)"
            return
        }
        currentURLString = s
        webView.load(URLRequest(url: url))
    }

    func reload() {
        webView.reload()
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        isLoading = true
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isLoading = false
        // Keep the address bar in sync with in-page navigation too (link
        // taps, redirects, JS navigation), not just calls to load(urlString:).
        if let url = webView.url {
            currentURLString = url.absoluteString
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        isLoading = false
        statusText = "ошибка загрузки: \(error.localizedDescription)"
    }

    // MARK: - helpers

    private func jsString(_ s: String) -> String {
        let escaped = s
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escaped)\""
    }
}
