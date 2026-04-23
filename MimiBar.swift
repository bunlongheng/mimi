import Cocoa
import Foundation

class MimiBar: NSObject {
    var statusItem: NSStatusItem!
    var statusMenuItem: NSMenuItem!
    var timer: Timer?

    override init() {
        super.init()
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        setupButton()
        setupMenu()
        poll()
        timer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in self?.poll() }
    }

    func setupButton() {
        guard let btn = statusItem.button else { return }
        if let img = NSImage(systemSymbolName: "ear", accessibilityDescription: "Mimi") {
            img.isTemplate = true
            btn.image = img
        } else {
            btn.title = "耳"
        }
    }

    func setupMenu() {
        let menu = NSMenu()

        let title = NSMenuItem(title: "Mimi 耳", action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)

        menu.addItem(.separator())

        statusMenuItem = NSMenuItem(title: "⬤  Checking...", action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)

        menu.addItem(.separator())

        let open = NSMenuItem(title: "Open Mimi", action: #selector(openMimi), keyEquivalent: "o")
        open.target = self
        menu.addItem(open)

        menu.addItem(.separator())

        let quit = NSMenuItem(title: "Quit MimiBar", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        statusItem.menu = menu
    }

    func poll() {
        guard let url = URL(string: "http://localhost:5757/api/session/status") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, resp, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                let ok = (resp as? HTTPURLResponse)?.statusCode == 200
                var capturing = false
                if ok, let data = data,
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    capturing = json["capturing"] as? Bool ?? false
                }
                self.updateUI(running: ok, capturing: capturing)
            }
        }.resume()
    }

    func updateUI(running: Bool, capturing: Bool) {
        guard let btn = statusItem.button else { return }

        if !running {
            if let img = NSImage(systemSymbolName: "ear", accessibilityDescription: "Mimi stopped") {
                img.isTemplate = true; btn.image = img
            }
            statusMenuItem.title = "○  Server stopped"
            statusMenuItem.attributedTitle = colored("○  Server stopped", color: .systemRed)
        } else if capturing {
            if let img = NSImage(systemSymbolName: "ear.fill", accessibilityDescription: "Mimi capturing") {
                img.isTemplate = false
                img.lockFocus()
                NSColor.systemGreen.set()
                NSBezierPath(rect: NSRect(x:0,y:0,width:img.size.width,height:img.size.height)).fill()
                img.unlockFocus()
                btn.image = img
            }
            statusMenuItem.attributedTitle = colored("⬤  Capturing live", color: .systemGreen)
        } else {
            if let img = NSImage(systemSymbolName: "ear", accessibilityDescription: "Mimi ready") {
                img.isTemplate = true; btn.image = img
            }
            statusMenuItem.attributedTitle = colored("○  Ready — not recording", color: .systemGray)
        }
    }

    func colored(_ text: String, color: NSColor) -> NSAttributedString {
        NSAttributedString(string: text, attributes: [.foregroundColor: color, .font: NSFont.menuFont(ofSize: 13)])
    }

    @objc func openMimi() {
        NSWorkspace.shared.open(URL(string: "http://localhost:5757")!)
    }

    @objc func quitApp() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let bar = MimiBar()
app.run()
