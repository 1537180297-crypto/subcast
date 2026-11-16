// Renders the DMG window background (640×400 pt) at 1x and 2x.
// usage: swift scripts/dmg-background.swift out.png out@2x.png
// Icon centres (Finder coordinates, y down): app (170, 196), Applications (470, 196).
// Keep in sync with scripts/dmg-settings.py and bundle.macOS.dmg in src-tauri/tauri.conf.json.
import AppKit

let args = CommandLine.arguments

func render(scale: CGFloat, to path: String) {
    let w: CGFloat = 640, h: CGFloat = 400
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(w * scale), pixelsHigh: Int(h * scale),
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: w, height: h)
    NSGraphicsContext.saveGraphicsState()
    // Flip so y grows downward like Finder's icon coordinates, and tell AppKit so text isn't mirrored.
    let cg = NSGraphicsContext(bitmapImageRep: rep)!.cgContext
    cg.translateBy(x: 0, y: h)
    cg.scaleBy(x: 1, y: -1)
    NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)

    // Light paper background with a soft accent glow behind the title.
    NSColor(srgbRed: 0.975, green: 0.982, blue: 0.978, alpha: 1).setFill()
    NSRect(x: 0, y: 0, width: w, height: h).fill()
    let glow = NSGradient(colors: [NSColor(srgbRed: 0.05, green: 0.48, blue: 0.41, alpha: 0.09), NSColor(srgbRed: 0.05, green: 0.48, blue: 0.41, alpha: 0)])!
    glow.draw(fromCenter: NSPoint(x: w / 2, y: -60), radius: 0, toCenter: NSPoint(x: w / 2, y: -60), radius: 440, options: [])

    // Small waveform mark above the wordmark, a quiet nod to "声渡".
    let amps: [CGFloat] = [0.35, 0.6, 1.0, 0.7, 0.45, 0.8, 0.55, 0.3]
    for (i, a) in amps.enumerated() {
        let bh = 4 + 14 * a
        let x = w / 2 - CGFloat(amps.count) * 3 + CGFloat(i) * 6
        NSColor(srgbRed: 0.05, green: 0.48, blue: 0.41, alpha: 0.75).setFill()
        NSBezierPath(roundedRect: NSRect(x: x, y: 30 - bh / 2, width: 3, height: bh), xRadius: 1.5, yRadius: 1.5).fill()
    }

    // Arrow between the two icons, at icon-centre height.
    let y: CGFloat = 186
    let accent = NSColor(srgbRed: 0.05, green: 0.48, blue: 0.41, alpha: 0.8)
    let line = NSBezierPath()
    line.move(to: NSPoint(x: 250, y: y)); line.line(to: NSPoint(x: 384, y: y))
    line.lineWidth = 2
    line.lineCapStyle = .round
    line.setLineDash([2, 7], count: 2, phase: 0)
    accent.setStroke()
    line.stroke()
    let head = NSBezierPath()
    head.move(to: NSPoint(x: 381, y: y - 7)); head.line(to: NSPoint(x: 390, y: y)); head.line(to: NSPoint(x: 381, y: y + 7))
    head.lineWidth = 2; head.lineCapStyle = .round; head.lineJoinStyle = .round
    head.stroke()

    // Copy.
    let para = NSMutableParagraphStyle(); para.alignment = .center
    func text(_ s: String, _ f: NSFont, _ color: NSColor, _ top: CGFloat, kern: CGFloat = 0) {
        let a = NSAttributedString(string: s, attributes: [.font: f, .foregroundColor: color, .paragraphStyle: para, .kern: kern])
        a.draw(in: NSRect(x: 0, y: top, width: w, height: 30))
    }
    text("SUBCAST · 声渡", .systemFont(ofSize: 11, weight: .semibold), NSColor(white: 0.42, alpha: 1), 46, kern: 1.6)
    text("拖到「应用程序」完成安装", .systemFont(ofSize: 15, weight: .medium), NSColor(white: 0.08, alpha: 1), 284)
    text("听懂海外播客和 YouTube", .systemFont(ofSize: 11.5, weight: .regular), NSColor(white: 0.46, alpha: 1), 308)

    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

render(scale: 1, to: args[1])
render(scale: 2, to: args[2])
