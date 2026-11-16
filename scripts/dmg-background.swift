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

    // Warm paper background with a soft top glow.
    NSColor(srgbRed: 0.985, green: 0.978, blue: 0.965, alpha: 1).setFill()
    NSRect(x: 0, y: 0, width: w, height: h).fill()
    let glow = NSGradient(colors: [NSColor(srgbRed: 1, green: 0.55, blue: 0.25, alpha: 0.10), NSColor(white: 1, alpha: 0)])!
    glow.draw(fromCenter: NSPoint(x: w / 2, y: -40), radius: 0, toCenter: NSPoint(x: w / 2, y: -40), radius: 420, options: [])

    // Sound-wave bars along the bottom, a quiet nod to "声渡".
    let bars = 64
    let barW: CGFloat = 3
    let gap = (w - CGFloat(bars) * barW) / CGFloat(bars + 1)
    for i in 0..<bars {
        let t = Double(i) / Double(bars - 1)
        let amp = 0.35 + 0.65 * abs(sin(t * .pi * 3.2) * cos(t * .pi * 1.3))
        let bh = CGFloat(6 + 22 * amp)
        let x = gap + CGFloat(i) * (barW + gap)
        NSColor(srgbRed: 0.93, green: 0.42, blue: 0.16, alpha: 0.10 + 0.10 * amp).setFill()
        NSBezierPath(roundedRect: NSRect(x: x, y: h - 18 - bh, width: barW, height: bh), xRadius: 1.5, yRadius: 1.5).fill()
    }

    // Arrow between the two icons, at icon-centre height.
    let y: CGFloat = 186
    let accent = NSColor(srgbRed: 0.93, green: 0.42, blue: 0.16, alpha: 0.85)
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
    text("SUBCAST · 声渡", .systemFont(ofSize: 11, weight: .semibold), NSColor(white: 0.45, alpha: 1), 40, kern: 1.6)
    text("拖到「应用程序」完成安装", .systemFont(ofSize: 15, weight: .medium), NSColor(white: 0.08, alpha: 1), 292)
    text("听懂海外播客和 YouTube", .systemFont(ofSize: 11.5, weight: .regular), NSColor(white: 0.46, alpha: 1), 318)

    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

render(scale: 1, to: args[1])
render(scale: 2, to: args[2])
