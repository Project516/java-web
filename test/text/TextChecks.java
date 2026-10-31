import java.awt.*;
import java.awt.font.*;
import java.awt.geom.*;
import java.awt.image.*;
import java.io.*;
import java.nio.file.*;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.*;

// Text drawing properties that hold for any font, so they also hold on
// HotSpot. Prints "ok name" or "FAIL name: why", one line per check.
public class TextChecks {
  static int failures;

  static void check(String name, boolean ok, Supplier<String> why) {
    if (ok) System.out.println("ok " + name);
    else {
      failures++;
      System.out.println("FAIL " + name + ": " + why.get());
    }
  }

  static void check(String name, boolean ok) {
    check(name, ok, () -> "");
  }

  static BufferedImage image(int type, int w, int h) {
    return new BufferedImage(w, h, type);
  }

  static Graphics2D aa(BufferedImage img, boolean on) {
    Graphics2D g = img.createGraphics();
    g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, on ? RenderingHints.VALUE_TEXT_ANTIALIAS_ON : RenderingHints.VALUE_TEXT_ANTIALIAS_OFF);
    g.setColor(Color.BLACK);
    return g;
  }

  // Bounding box of the pixels with alpha above zero, or null
  static Rectangle ink(BufferedImage img) {
    int x1 = Integer.MAX_VALUE, y1 = x1, x2 = -1, y2 = -1;
    for (int y = 0; y < img.getHeight(); y++) {
      for (int x = 0; x < img.getWidth(); x++) {
        if ((img.getRGB(x, y) >>> 24) != 0) {
          x1 = Math.min(x1, x);
          y1 = Math.min(y1, y);
          x2 = Math.max(x2, x);
          y2 = Math.max(y2, y);
        }
      }
    }
    return x2 < 0 ? null : new Rectangle(x1, y1, x2 - x1 + 1, y2 - y1 + 1);
  }

  static int inkCount(BufferedImage img) {
    int n = 0;
    for (int y = 0; y < img.getHeight(); y++) for (int x = 0; x < img.getWidth(); x++) if ((img.getRGB(x, y) >>> 24) != 0) n++;
    return n;
  }

  static Set<Integer> alphas(BufferedImage img) {
    Set<Integer> s = new TreeSet<>();
    for (int y = 0; y < img.getHeight(); y++) for (int x = 0; x < img.getWidth(); x++) s.add(img.getRGB(x, y) >>> 24);
    return s;
  }

  static BufferedImage drawn(String text, Font font, boolean antialias, int w, int h) {
    BufferedImage img = image(BufferedImage.TYPE_INT_ARGB, w, h);
    Graphics2D g = aa(img, antialias);
    g.setFont(font);
    g.drawString(text, 20, h / 2);
    g.dispose();
    return img;
  }

  public static void main(String[] args) throws Exception {
    System.setProperty("java.awt.headless", "true");
    Font plain = new Font("SansSerif", Font.PLAIN, 24);

    // fonts and names
    List<String> families = Arrays.asList(GraphicsEnvironment.getLocalGraphicsEnvironment().getAvailableFontFamilyNames());
    check("family list has DejaVu Sans", families.contains("DejaVu Sans"), () -> families.toString());
    check("family list has logical fonts", families.containsAll(List.of("Dialog", "DialogInput", "Monospaced", "SansSerif", "Serif")), () -> families.toString());
    for (String n : new String[] {"Dialog", "SansSerif", "Serif", "Monospaced", "DialogInput", "DejaVu Sans"}) {
      Font f = new Font(n, Font.PLAIN, 20);
      check("font " + n + " keeps its family", f.getFamily().equals(n), () -> f.getFamily());
      check("font " + n + " draws", ink(drawn("Hag", f, true, 100, 50)) != null);
    }
    check("unknown font falls back to Dialog", new Font("No Such Font", Font.PLAIN, 12).getFamily().equals("Dialog"));
    check("DejaVu Sans is not a logical name", new Font("DejaVu Sans", Font.BOLD, 12).getFontName().startsWith("DejaVu Sans"));

    // metrics
    BufferedImage scratch = image(BufferedImage.TYPE_INT_ARGB, 1, 1);
    Graphics2D sg = scratch.createGraphics();
    FontMetrics fm = sg.getFontMetrics(plain);
    check("ascent and descent are positive", fm.getAscent() > 0 && fm.getDescent() > 0 && fm.getLeading() >= 0);
    check("height covers ascent, descent and leading", fm.getHeight() == fm.getAscent() + fm.getDescent() + fm.getLeading());
    check("ascent exceeds cap height", fm.getAscent() >= (int) (plain.getSize() * 0.7));
    check("bigger fonts have bigger metrics", sg.getFontMetrics(plain.deriveFont(48f)).getHeight() > fm.getHeight() * 3 / 2);
    check("wide letters measure wider", fm.charWidth('W') > fm.charWidth('i'));
    check("longer strings measure wider", fm.stringWidth("Hello, world") > fm.stringWidth("Hello"));
    check("string width adds up", Math.abs(fm.stringWidth("Hello") - (fm.charWidth('H') + fm.charWidth('e') + fm.charWidth('l') * 2 + fm.charWidth('o'))) <= 1);
    check("empty string has no width", fm.stringWidth("") == 0);
    check("max advance covers every char", fm.getMaxAdvance() >= fm.charWidth('W'));
    Rectangle2D sb = fm.getStringBounds("Hello", sg);
    check("string bounds match the width", Math.abs(sb.getWidth() - fm.stringWidth("Hello")) < 1.5, () -> sb + " " + fm.stringWidth("Hello"));
    check("string bounds sit above the baseline", sb.getY() < 0 && sb.getY() + sb.getHeight() > 0, () -> sb.toString());
    FontRenderContext frcFm = new FontRenderContext(null, true, true), frcInt = new FontRenderContext(null, true, false);
    double fracW = plain.getStringBounds("Hello, world", frcFm).getWidth(), intW = plain.getStringBounds("Hello, world", frcInt).getWidth();
    check("whole pixel advances without fractional metrics", intW == Math.rint(intW), () -> "" + intW);
    check("fractional metrics measure fractions", fracW != Math.rint(fracW) && Math.abs(fracW - intW) < 12, () -> fracW + " " + intW);
    LineMetrics lm = plain.getLineMetrics("Hello", frcFm);
    check("line metrics", lm.getAscent() > 0 && lm.getDescent() > 0 && lm.getHeight() >= lm.getAscent() + lm.getDescent() && lm.getUnderlineOffset() > 0 && lm.getStrikethroughOffset() < 0);

    // drawString
    Rectangle expect = null;
    BufferedImage hello = drawn("Hello, World", plain, true, 260, 60);
    Rectangle box = ink(hello);
    Rectangle2D sbounds = plain.getStringBounds("Hello, World", frcInt);
    check("drawString leaves ink", box != null);
    check("ink stays inside the string bounds", box != null && new Rectangle2D.Double(20 + sbounds.getX() - 2, 30 + sbounds.getY() - 2, sbounds.getWidth() + 4, sbounds.getHeight() + 4).contains(box),
      () -> box + " vs " + sbounds);
    check("ink fills most of the string width", box != null && box.width > sbounds.getWidth() * 0.8, () -> box + " vs " + sbounds);
    check("ink sits on the baseline", box != null && box.y + box.height >= 30 && box.y + box.height <= 30 + fm.getDescent() + 2);
    BufferedImage wide = drawn("Hello, World, and more", plain, true, 400, 60);
    check("longer strings draw wider", ink(wide).width > box.width + 30);
    check("bigger fonts draw bigger", ink(drawn("Hello", plain.deriveFont(48f), true, 300, 80)).height > ink(drawn("Hello", plain, true, 300, 80)).height * 3 / 2);

    // antialiasing
    Set<Integer> aaAlphas = alphas(hello);
    check("antialiased text has partial alpha", aaAlphas.size() > 4 && aaAlphas.contains(255) && aaAlphas.contains(0), () -> aaAlphas.toString());
    Set<Integer> bwAlphas = alphas(drawn("Hello, World", plain, false, 260, 60));
    check("plain text is all or nothing", bwAlphas.equals(Set.of(0, 255)), () -> bwAlphas.toString());
    BufferedImage lcd = image(BufferedImage.TYPE_INT_RGB, 260, 60);
    Graphics2D lg = lcd.createGraphics();
    lg.setColor(Color.WHITE);
    lg.fillRect(0, 0, 260, 60);
    lg.setColor(Color.BLACK);
    lg.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_LCD_HRGB);
    lg.setFont(plain);
    lg.drawString("Hello, World", 20, 30);
    Set<Integer> lcdGrays = new TreeSet<>();
    for (int y = 0; y < 60; y++) for (int x = 0; x < 260; x++) lcdGrays.add(lcd.getRGB(x, y) & 0xff);
    check("LCD text draws with partial coverage", lcdGrays.size() > 4, () -> lcdGrays.toString());

    // style
    Font bold = plain.deriveFont(Font.BOLD), italic = plain.deriveFont(Font.ITALIC);
    int plainInk = inkCount(drawn("Hamburg", plain, true, 260, 60)), boldInk = inkCount(drawn("Hamburg", bold, true, 260, 60));
    check("bold has more ink", boldInk > plainInk * 1.05, () -> boldInk + " vs " + plainInk);
    BufferedImage it = drawn("HHH", italic, true, 200, 60);
    Rectangle ib = ink(it);
    int topLeft = -1, bottomLeft = -1;
    for (int x = 0; x < 200 && (topLeft < 0 || bottomLeft < 0); x++) {
      if (topLeft < 0 && (it.getRGB(x, ib.y + 1) >>> 24) > 128) topLeft = x;
      if (bottomLeft < 0 && (it.getRGB(x, ib.y + ib.height - 2) >>> 24) > 128) bottomLeft = x;
    }
    int tl = topLeft, bl = bottomLeft;
    check("italic leans right", tl > bl + 2, () -> tl + " vs " + bl);
    check("bold italic draws", ink(drawn("Hamburg", plain.deriveFont(Font.BOLD | Font.ITALIC), true, 260, 60)) != null);

    // transforms
    BufferedImage rot = image(BufferedImage.TYPE_INT_ARGB, 120, 260);
    Graphics2D rg = aa(rot, true);
    rg.setFont(plain);
    rg.translate(60, 240);
    rg.rotate(-Math.PI / 2);
    rg.drawString("Hello, World", 0, 0);
    Rectangle rb = ink(rot);
    check("quarter turn swaps the ink extents", rb != null && rb.height > rb.width * 3 && Math.abs(rb.height - box.width) < 6, () -> rb + " vs " + box);
    BufferedImage scaled = image(BufferedImage.TYPE_INT_ARGB, 500, 120);
    Graphics2D sg2 = aa(scaled, true);
    sg2.setFont(plain);
    sg2.scale(2, 2);
    sg2.drawString("Hello, World", 10, 30);
    Rectangle scb = ink(scaled);
    check("scaling doubles the ink", scb != null && Math.abs(scb.width - 2 * box.width) < 0.08 * box.width + 4 && Math.abs(scb.height - 2 * box.height) < 8, () -> scb + " vs " + box);
    BufferedImage shear = image(BufferedImage.TYPE_INT_ARGB, 300, 60);
    Graphics2D shg = aa(shear, true);
    shg.setFont(plain);
    shg.shear(0.5, 0);
    shg.drawString("Hello", 0, 40);
    Rectangle shb = ink(shear);
    check("shear widens the ink", shb != null && shb.width > ink(drawn("Hello", plain, true, 300, 80)).width + 5, () -> "" + shb);
    Font rotated = plain.deriveFont(AffineTransform.getRotateInstance(Math.PI / 2));
    Rectangle rotb = ink(drawn("Hello", rotated, true, 120, 120));
    check("rotated fonts draw sideways", rotb != null && rotb.height > rotb.width, () -> "" + rotb);

    // clip and composite
    BufferedImage clipped = image(BufferedImage.TYPE_INT_ARGB, 260, 60);
    Graphics2D cg = aa(clipped, true);
    cg.setFont(plain);
    cg.setClip(60, 0, 50, 60);
    cg.drawString("Hello, World", 20, 30);
    Rectangle cb = ink(clipped);
    check("rectangular clip bounds the ink", cb != null && cb.x >= 60 && cb.x + cb.width <= 110, () -> "" + cb);
    BufferedImage shaped = image(BufferedImage.TYPE_INT_ARGB, 260, 60);
    Graphics2D hg = aa(shaped, true);
    hg.setFont(plain);
    hg.setClip(new Ellipse2D.Double(40, 0, 80, 60));
    hg.drawString("Hello, World", 20, 30);
    Rectangle hb = ink(shaped);
    check("shaped clip bounds the ink", hb != null && hb.x >= 40 && hb.x + hb.width <= 120, () -> "" + hb);
    BufferedImage half = image(BufferedImage.TYPE_INT_ARGB, 200, 80);
    Graphics2D ag = aa(half, true);
    ag.setFont(plain.deriveFont(60f));
    ag.setComposite(AlphaComposite.getInstance(AlphaComposite.SRC_OVER, 0.5f));
    ag.setColor(Color.RED);
    ag.drawString("H", 20, 60);
    int maxA = 0, rgb = 0;
    for (int y = 0; y < 80; y++) for (int x = 0; x < 200; x++) if ((half.getRGB(x, y) >>> 24) > maxA) { maxA = half.getRGB(x, y) >>> 24; rgb = half.getRGB(x, y) & 0xffffff; }
    int fa = maxA, fr = rgb;
    check("half transparent text tops out at half alpha", fa >= 126 && fa <= 129 && fr == 0xff0000, () -> fa + " " + Integer.toHexString(fr));
    BufferedImage colored = image(BufferedImage.TYPE_INT_ARGB, 200, 80);
    Graphics2D colg = aa(colored, true);
    colg.setFont(plain.deriveFont(60f));
    colg.setColor(new Color(10, 200, 30));
    colg.drawString("H", 20, 60);
    int solid = colored.getRGB(26, 40);
    check("text has the paint color", (solid & 0xffffff) == 0x0ac81e && (solid >>> 24) == 255, () -> Integer.toHexString(solid));
    BufferedImage over = image(BufferedImage.TYPE_INT_RGB, 200, 80);
    Graphics2D og = over.createGraphics();
    og.setColor(Color.WHITE);
    og.fillRect(0, 0, 200, 80);
    og.setColor(Color.BLACK);
    og.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
    og.setFont(plain.deriveFont(60f));
    og.drawString("Hag", 20, 60);
    int grays = 0, darks = 0;
    for (int y = 0; y < 80; y++) for (int x = 0; x < 200; x++) { int p = over.getRGB(x, y) & 0xff; if (p > 0 && p < 255) grays++; if (p == 0) darks++; }
    int gr = grays, dk = darks;
    check("antialiasing blends into the background", gr > 20 && dk > 100, () -> gr + " grays " + dk + " darks");

    // image types
    int[] types = {BufferedImage.TYPE_INT_RGB, BufferedImage.TYPE_INT_ARGB_PRE, BufferedImage.TYPE_INT_BGR, BufferedImage.TYPE_3BYTE_BGR,
      BufferedImage.TYPE_4BYTE_ABGR, BufferedImage.TYPE_4BYTE_ABGR_PRE, BufferedImage.TYPE_BYTE_GRAY, BufferedImage.TYPE_USHORT_565_RGB, BufferedImage.TYPE_USHORT_555_RGB,
      BufferedImage.TYPE_BYTE_BINARY, BufferedImage.TYPE_BYTE_INDEXED, BufferedImage.TYPE_USHORT_GRAY};
    for (int type : types) {
      for (boolean antialias : new boolean[] {true, false}) {
        BufferedImage img = image(type, 120, 50);
        Graphics2D g = img.createGraphics();
        g.setColor(Color.WHITE);
        g.fillRect(0, 0, 120, 50);
        g.setColor(Color.BLACK);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, antialias ? RenderingHints.VALUE_TEXT_ANTIALIAS_ON : RenderingHints.VALUE_TEXT_ANTIALIAS_OFF);
        g.setFont(plain);
        g.drawString("Hag", 10, 35);
        int dark = 0, light = 0;
        for (int y = 0; y < 50; y++) for (int x = 0; x < 120; x++) { int p = img.getRGB(x, y) & 0xffffff; int v = (p >> 16 & 255) + (p >> 8 & 255) + (p & 255); if (v < 200) dark++; else if (v > 560) light++; }
        int d = dark, l = light;
        check("type " + type + (antialias ? " AA" : " plain") + " draws dark text on light", d > 80 && l > 3000, () -> d + " dark " + l + " light");
      }
    }

    // GlyphVector, TextLayout, outlines
    GlyphVector gv = plain.createGlyphVector(frcFm, "Hello");
    check("glyph vector has a glyph per char", gv.getNumGlyphs() == 5);
    Rectangle2D logical = gv.getLogicalBounds(), visual = gv.getVisualBounds();
    check("visual bounds sit inside the logical ones", logical.getWidth() > 0 && logical.contains(visual.getX() + 0.5, visual.getY() + 0.5) && visual.getWidth() <= logical.getWidth() + 4,
      () -> logical + " vs " + visual);
    Rectangle2D outline = gv.getOutline().getBounds2D();
    check("outline bounds match the visual bounds", Math.abs(outline.getWidth() - visual.getWidth()) < 1 && Math.abs(outline.getHeight() - visual.getHeight()) < 1, () -> outline + " vs " + visual);
    check("glyph outlines are narrower than the vector", gv.getGlyphOutline(0).getBounds2D().getWidth() < outline.getWidth() / 2);
    check("glyph positions rise", gv.getGlyphPosition(1).getX() > gv.getGlyphPosition(0).getX() && gv.getGlyphPosition(5).getX() > gv.getGlyphPosition(4).getX());
    check("glyph metrics have advances", gv.getGlyphMetrics(0).getAdvanceX() > 0 && gv.getGlyphMetrics(0).getBounds2D().getHeight() > 0);
    BufferedImage gvImg = image(BufferedImage.TYPE_INT_ARGB, 200, 60);
    Graphics2D gg = aa(gvImg, true);
    gg.drawGlyphVector(gv, 20, 40);
    Rectangle gvb = ink(gvImg);
    check("drawGlyphVector draws inside the visual bounds", gvb != null && new Rectangle2D.Double(20 + visual.getX() - 2, 40 + visual.getY() - 2, visual.getWidth() + 4, visual.getHeight() + 4).contains(gvb),
      () -> gvb + " vs " + visual);
    TextLayout layout = new TextLayout("Hello, World", plain, frcFm);
    check("text layout measures", layout.getAdvance() > 50 && layout.getAscent() > 0 && layout.getDescent() > 0 && layout.getCharacterCount() == 12);
    BufferedImage tlImg = image(BufferedImage.TYPE_INT_ARGB, 260, 60);
    Graphics2D tg = aa(tlImg, true);
    new TextLayout("Hello, World", plain, frcInt).draw(tg, 20, 30);
    Rectangle tb = ink(tlImg);
    check("TextLayout.draw leaves ink near drawString's", tb != null && Math.abs(tb.width - box.width) < 4 && Math.abs(tb.height - box.height) < 4, () -> tb + " vs " + box);
    TextHitInfo hit = layout.hitTestChar((float) layout.getAdvance() - 1, 5);
    check("hit testing the end reaches the last char", hit.getCharIndex() == 11, () -> hit.toString());
    check("caret shape has height", layout.getCaretShape(TextHitInfo.leading(3)).getBounds2D().getHeight() > 0);
    check("layout outline has area", layout.getOutline(null).getBounds2D().getWidth() > layout.getAdvance() * 0.8);
    check("bounds of the 1x layout match", Math.abs(layout.getBounds().getWidth() - layout.getAdvance()) < 6);

    Font kerned = plain.deriveFont(Map.of(TextAttribute.KERNING, TextAttribute.KERNING_ON));
    check("kerning pulls letters together", kerned.getStringBounds("AVAWA To", frcFm).getWidth() < plain.getStringBounds("AVAWA To", frcFm).getWidth() - 1);

    // odd text
    check("empty string draws nothing", ink(drawn("", plain, true, 60, 60)) == null);
    check("space draws nothing", ink(drawn("   ", plain, true, 60, 60)) == null);
    check("missing glyph code is 0", plain.createGlyphVector(frcFm, "中").getGlyphCode(0) == 0 || !plain.canDisplay('中'));
    check("canDisplay tells", plain.canDisplay('A') && !plain.canDisplay('中') && plain.canDisplayUpTo("abc中") == 3);
    Rectangle missing = ink(drawn("中", plain, true, 60, 60));
    check("a missing character draws the missing glyph", missing != null && missing.width > 3 && missing.height > 8, () -> "" + missing);
    check("a missing character has width", plain.getStringBounds("中", frcFm).getWidth() > 4);
    check("accented letters draw taller", ink(drawn("é", plain, true, 60, 60)).height > ink(drawn("e", plain, true, 60, 60)).height);
    check("surrogate pairs draw", ink(drawn("😀", plain, true, 60, 60)) != null);
    check("controls do not throw", ink(drawn("a\tb\nc\u0000d​e", plain, true, 120, 60)) != null);
    check("combining marks draw", ink(drawn("á", plain, true, 60, 60)) != null);
    check("right to left text draws", ink(drawn("אבג", plain, true, 100, 60)) != null);
    check("drawChars draws", drawChars(plain));
    check("character iterator text draws", drawIterator(plain));

    // large text goes through the outline renderer
    Rectangle big = ink(drawn("Hg", plain.deriveFont(180f), true, 400, 300));
    check("huge text draws", big != null && big.height > 120, () -> "" + big);

    // a font from a file
    Path ttf = Path.of(System.getProperty("java.home"), "lib", "fonts", "DejaVuSans.ttf");
    if (Files.exists(ttf)) {
      Font created = Font.createFont(Font.TRUETYPE_FONT, ttf.toFile()).deriveFont(24f);
      check("created fonts draw", ink(drawn("Hag", created, true, 100, 50)) != null);
      check("created fonts name themselves", created.getFamily().length() > 0 && created.canDisplay('A'));
    }

    // text after the font cache is cleared still works
    System.gc();
    check("redrawn text is the same", Arrays.equals(pixels(drawn("Hello, World", plain, true, 260, 60)), pixels(hello)));

    // a font whose cmap is zeroed is bad: it falls back to a font that works, as on HotSpot
    byte[] bytes = Files.readAllBytes(Path.of("/jdk/lib/fonts/DejaVuSans.ttf"));
    int cmap = tableAt(bytes, "cmap"), cmapLen = tableLen(bytes, "cmap");
    Arrays.fill(bytes, cmap, cmap + cmapLen, (byte) 0);
    Path bad = Files.createTempFile("zerocmap", ".ttf");
    Files.write(bad, bytes);
    Font zeroed = Font.createFont(Font.TRUETYPE_FONT, bad.toFile()).deriveFont(24f);
    Files.delete(bad);
    check("zeroed cmap font still draws", ink(drawn("Hag", zeroed, true, 100, 50)) != null);
    check("zeroed cmap font still measures", zeroed.getStringBounds("Hag", sg.getFontRenderContext()).getWidth() > 20);

    System.out.println(failures == 0 ? "done" : failures + " failed");
    System.exit(failures == 0 ? 0 : 1);
  }

  static int tableEntry(byte[] b, String tag) {
    for (int i = 0, n = (b[4] & 255) << 8 | (b[5] & 255); i < n; i++) {
      if (new String(b, 12 + i * 16, 4).equals(tag)) return 12 + i * 16;
    }
    throw new IllegalStateException(tag);
  }

  static int u32(byte[] b, int o) {
    return (b[o] & 255) << 24 | (b[o + 1] & 255) << 16 | (b[o + 2] & 255) << 8 | (b[o + 3] & 255);
  }

  static int tableAt(byte[] b, String tag) {
    return u32(b, tableEntry(b, tag) + 8);
  }

  static int tableLen(byte[] b, String tag) {
    return u32(b, tableEntry(b, tag) + 12);
  }

  static boolean drawChars(Font font) {
    BufferedImage img = image(BufferedImage.TYPE_INT_ARGB, 100, 50);
    Graphics2D g = aa(img, true);
    g.setFont(font);
    g.drawChars(new char[] {'a', 'b', 'c', 'd'}, 1, 2, 10, 30);
    g.drawBytes(new byte[] {'x', 'y'}, 0, 2, 50, 30);
    return ink(img) != null;
  }

  static boolean drawIterator(Font font) {
    java.text.AttributedString as = new java.text.AttributedString("Hello world");
    as.addAttribute(TextAttribute.FONT, font);
    as.addAttribute(TextAttribute.UNDERLINE, TextAttribute.UNDERLINE_ON, 0, 5);
    as.addAttribute(TextAttribute.FOREGROUND, Color.BLUE, 6, 11);
    BufferedImage img = image(BufferedImage.TYPE_INT_ARGB, 200, 50);
    Graphics2D g = aa(img, true);
    g.drawString(as.getIterator(), 10, 30);
    return ink(img) != null;
  }

  static int[] pixels(BufferedImage img) {
    return img.getRGB(0, 0, img.getWidth(), img.getHeight(), null, 0, img.getWidth());
  }
}
