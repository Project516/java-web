import java.awt.Font;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.Shape;
import java.awt.font.FontRenderContext;
import java.awt.font.GlyphVector;
import java.awt.font.LineMetrics;
import java.awt.geom.PathIterator;
import java.awt.image.BufferedImage;
import java.awt.font.TextLayout;
import java.io.File;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.zip.CRC32;

// Metrics, advances and outlines of the font file in args[0], with fractional
// metrics on. These do not depend on the rasterizer, so they must match HotSpot.
public class FontMatch {
  static FontRenderContext frc;

  public static void main(String[] args) throws Exception {
    Font base = Font.createFont(Font.TRUETYPE_FONT, new File(args[0]));
    Graphics2D g = new BufferedImage(10, 10, BufferedImage.TYPE_INT_ARGB).createGraphics();
    g.setRenderingHint(RenderingHints.KEY_FRACTIONALMETRICS, RenderingHints.VALUE_FRACTIONALMETRICS_ON);
    g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
    frc = g.getFontRenderContext();
    for (float size : new float[] {9, 12, 17.5f, 40}) {
      Font f = base.deriveFont(size);
      LineMetrics lm = f.getLineMetrics("Hag", frc);
      System.out.println(size + " ascent " + lm.getAscent() + " descent " + lm.getDescent() + " leading " + lm.getLeading()
          + " width " + f.getStringBounds("Hello, World", frc).getWidth());
      GlyphVector gv = f.createGlyphVector(frc, "AVg@ fi");
      for (int i = 0; i < gv.getNumGlyphs(); i++) {
        StringBuilder sb = new StringBuilder("  " + gv.getGlyphMetrics(i).getAdvance() + " " + gv.getGlyphPosition(i));
        double[] c = new double[6];
        for (PathIterator it = gv.getGlyphOutline(i).getPathIterator(null); !it.isDone(); it.next()) {
          int type = it.currentSegment(c);
          sb.append(' ').append(type);
          int n = type == PathIterator.SEG_CUBICTO ? 6 : type == PathIterator.SEG_QUADTO ? 4 : type == PathIterator.SEG_CLOSE ? 0 : 2;
          for (int k = 0; k < n; k++) sb.append(',').append((float) c[k]);
        }
        System.out.println(sb);
      }
    }
    styles(base);
    special(base);
    byte[] bytes = Files.readAllBytes(new File(args[0]).toPath());
    lifetime(bytes);
    variants(bytes, base);
  }

  static String path(Shape s) {
    StringBuilder sb = new StringBuilder();
    double[] c = new double[6];
    for (PathIterator it = s.getPathIterator(null); !it.isDone(); it.next()) {
      int type = it.currentSegment(c);
      sb.append(type);
      int n = type == PathIterator.SEG_CUBICTO ? 6 : type == PathIterator.SEG_QUADTO ? 4 : type == PathIterator.SEG_CLOSE ? 0 : 2;
      for (int k = 0; k < n; k++) sb.append(',').append((float) c[k]);
    }
    return sb.toString();
  }

  static String crc(String s) {
    CRC32 c = new CRC32();
    c.update(s.getBytes());
    return Long.toHexString(c.getValue());
  }

  // Advances, bounds and outlines of a spread of glyphs at awkward sizes and in every style
  static void styles(Font base) {
    StringBuilder text = new StringBuilder();
    for (char ch = 33; ch < 127; ch++) text.append(ch);
    text.append("\u00e9\u00df\u00f1\u20ac\u0416");
    String[] names = {"plain", "bold", "italic", "bold italic"};
    int[] styles = {Font.PLAIN, Font.BOLD, Font.ITALIC, Font.BOLD | Font.ITALIC};
    for (float size : new float[] {7.3f, 13.37f, 17.5f, 23.1f}) {
      for (int s = 0; s < styles.length; s++) {
        GlyphVector gv = base.deriveFont(styles[s], size).createGlyphVector(frc, text.toString());
        StringBuilder adv = new StringBuilder(), bounds = new StringBuilder(), outline = new StringBuilder();
        for (int i = 0; i < gv.getNumGlyphs(); i++) {
          adv.append(gv.getGlyphMetrics(i).getAdvance()).append(' ');
          bounds.append(gv.getGlyphVisualBounds(i).getBounds2D()).append(' ');
          outline.append(path(gv.getGlyphOutline(i))).append(' ');
        }
        System.out.println(size + " " + names[s] + " adv " + crc(adv.toString()) + " bounds " + crc(bounds.toString()) + " outline " + crc(outline.toString()));
      }
    }
    Font italic = base.deriveFont(Font.ITALIC, 17.5f);
    System.out.println("italic " + italic.createGlyphVector(frc, "AB").getGlyphVisualBounds(1).getBounds2D());
    System.out.println("7.3 " + base.deriveFont(7.3f).createGlyphVector(frc, "AB").getGlyphMetrics(0).getAdvance());
  }

  static void layout(Font f, String name, String s) {
    GlyphVector gv = f.layoutGlyphVector(frc, s.toCharArray(), 0, s.length(), Font.LAYOUT_LEFT_TO_RIGHT);
    StringBuilder sb = new StringBuilder(name + ":");
    for (int i = 0; i < gv.getNumGlyphs(); i++) sb.append(' ').append(gv.getGlyphCode(i)).append('@').append(gv.getGlyphPosition(i).getX());
    System.out.println(sb + " end " + gv.getGlyphPosition(gv.getNumGlyphs()).getX());
  }

  // Control, format and default-ignorable characters between two letters
  static void special(Font base) {
    Font f = base.deriveFont(20f);
    int[] cps = {0, 1, 8, 9, 0xa, 0xb, 0xc, 0xd, 0xe, 0x1f, 0x7f, 0x85, 0xa0, 0xad, 0x34f, 0x61c, 0x17b4, 0x17b5, 0x180b, 0x180e, 0x180f,
      0x2000, 0x200a, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x202f, 0x2060, 0x2064, 0x2065, 0x206a, 0x206f,
      0xfe00, 0xfe0f, 0xfeff, 0xfff0, 0xfff8, 0xfff9, 0xfffd, 0xffff, 0x1d173, 0x1d17a, 0x1d17b, 0xe0000, 0xe0001, 0xe0100, 0xe0fff, 0xe1000, 0x10000, 0x1680, 0x3000};
    for (int cp : cps) layout(f, String.format("U+%04X", cp), "A" + new String(Character.toChars(cp)) + "1");
    layout(f, "mixed", "\u200b\u00ad\ufff01");
    layout(f, "lone high surrogate", "A\ud8001");
    layout(f, "lone low surrogate", "A\udc001");
    layout(f, "AV", "AV");
    layout(f, "A ZWSP V", "A\u200bV");
    layout(f, "A TAB V", "A\tV");
    TextLayout tl = new TextLayout("a\tb\nc\u2028d", f, frc);
    System.out.println("TextLayout " + tl.getAdvance() + " " + tl.getCharacterCount() + " " + tl.getBounds());
    layout(f, "tabs and newlines", "a\tb\nc\r\nd");
  }

  static String summary(Font created) {
    Font d = created.deriveFont(20f);
    StringBuilder sb = new StringBuilder();
    LineMetrics lm = d.getLineMetrics("Hag", frc);
    sb.append("asc=" + lm.getAscent() + " desc=" + lm.getDescent());
    GlyphVector gv = d.createGlyphVector(frc, "AH");
    for (int i = 0; i < 2; i++) {
      sb.append(" g" + gv.getGlyphCode(i) + " adv=" + gv.getGlyphMetrics(i).getAdvance() + " " + gv.getGlyphVisualBounds(i).getBounds2D());
      sb.append(" " + crc(path(gv.getGlyphOutline(i))));
    }
    sb.append(" " + d.getStringBounds("AH", frc));
    BufferedImage img = new BufferedImage(60, 40, BufferedImage.TYPE_INT_ARGB);
    Graphics2D g = img.createGraphics();
    g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
    g.setFont(d);
    g.drawString("AH", 5, 30);
    boolean ink = false;
    for (int y = 0; y < 40; y++) for (int x = 0; x < 60; x++) ink |= (img.getRGB(x, y) >>> 24) != 0;
    return sb + " drawn=" + ink;
  }

  // The font keeps working after its file is deleted, and a rewritten path does not change a font made earlier
  static void lifetime(byte[] bytes) throws Exception {
    File f = File.createTempFile("fontmatch", ".ttf");
    Files.write(f.toPath(), bytes);
    Font gone = Font.createFont(Font.TRUETYPE_FONT, f);
    f.delete();
    System.out.println("deleted " + summary(gone));
    Files.write(f.toPath(), bytes);
    Font first = Font.createFont(Font.TRUETYPE_FONT, f);
    System.out.println("before rewrite " + summary(first));
    byte[] other = bytes.clone();
    put16(other, table(other, "head") + 18, 4096);
    Files.write(f.toPath(), other);
    Font second = Font.createFont(Font.TRUETYPE_FONT, f);
    System.out.println("second " + summary(second));
    System.out.println("first after rewrite " + summary(first));
    f.delete();
  }

  static int get16(byte[] b, int o) {
    return (b[o] & 255) << 8 | (b[o + 1] & 255);
  }

  static void put16(byte[] b, int o, int v) {
    b[o] = (byte) (v >> 8);
    b[o + 1] = (byte) v;
  }

  static void put32(byte[] b, int o, int v) {
    put16(b, o, v >>> 16);
    put16(b, o + 2, v);
  }

  static int get32(byte[] b, int o) {
    return get16(b, o) << 16 | get16(b, o + 2);
  }

  static int table(byte[] b, String tag) {
    for (int i = 0, n = get16(b, 4); i < n; i++) {
      int p = 12 + i * 16;
      if (new String(b, p, 4).equals(tag)) return get32(b, p + 8);
    }
    throw new IllegalStateException(tag);
  }

  static int glyphOffset(byte[] b, int gid) {
    boolean wide = get16(b, table(b, "head") + 50) != 0;
    int loca = table(b, "loca");
    return table(b, "glyf") + (wide ? get32(b, loca + gid * 4) : get16(b, loca + gid * 2) * 2);
  }

  static void variant(String name, byte[] data) throws Exception {
    File f = File.createTempFile("fontmatch", ".ttf");
    Files.write(f.toPath(), data);
    String line;
    try {
      line = "created " + summary(Font.createFont(Font.TRUETYPE_FONT, f));
    } catch (Exception e) {
      line = "failed " + e.getClass().getName();
    }
    f.delete();
    System.out.println(name + ": " + line);
  }

  // Fonts FreeType rejects or half loads
  static void variants(byte[] orig, Font base) throws Exception {
    int a = base.createGlyphVector(frc, "A").getGlyphCode(0);
    int head = table(orig, "head");
    variant("bad head magic", flip(orig, head + 12));
    for (int upem : new int[] {0, 1, 15, 16, 16384, 16385}) {
      byte[] b = orig.clone();
      put16(b, head + 18, upem);
      variant("unitsPerEm " + upem, b);
    }
    int o = glyphOffset(orig, a), len = glyphOffset(orig, a + 1) - o;
    byte[] b = orig.clone();
    Arrays.fill(b, o, o + len, (byte) 0xff);
    variant("glyph all ff", b);
    b = orig.clone();
    put16(b, o + 10 + (get16(b, o) - 1) * 2, 60000);
    variant("end point past the data", b);
    b = orig.clone();
    put16(b, o, 0xffff);
    put16(b, o + 10, 2);
    put16(b, o + 12, a);
    put16(b, o + 14, 0);
    variant("self composite", b);
    b = orig.clone();
    System.arraycopy("OTTO".getBytes(), 0, b, 0, 4);
    variant("OTTO without CFF", b);
    b = orig.clone();
    System.arraycopy("true".getBytes(), 0, b, 0, 4);
    variant("true tag", b);
    byte[] ttc = new byte[orig.length + 16];
    System.arraycopy(orig, 0, ttc, 16, orig.length);
    System.arraycopy("ttcf".getBytes(), 0, ttc, 0, 4);
    put16(ttc, 4, 1);
    put16(ttc, 10, 1);
    put16(ttc, 14, 16);
    for (int i = 0, n = get16(orig, 4); i < n; i++) {
      int p = 16 + 12 + i * 16 + 8;
      put32(ttc, p, get32(ttc, p) + 16);
    }
    variant("collection", ttc);
  }

  static byte[] flip(byte[] b, int at) {
    b = b.clone();
    b[at] ^= 1;
    return b;
  }
}
