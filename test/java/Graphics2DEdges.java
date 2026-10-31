import java.awt.*;
import java.awt.geom.*;
import java.awt.image.*;
import java.util.function.Consumer;
import java.util.zip.CRC32;

// Graphics2D corner cases on every image type, including the indexed, packed and 16-bit gray ones: XOR mode, lines and polylines
// with huge or wrapping coordinates, rectangles near Integer.MAX_VALUE and
// transforms that collapse the image. Each scene prints a CRC32 of the getRGB
// pixels and one of the raw DataBuffer words, and both must equal HotSpot's.
public class Graphics2DEdges {
  static final int MAX = Integer.MAX_VALUE;

  static BufferedImage make(int kind, int w, int h) {
    switch (kind) {
      case 0: return new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
      case 1: return new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
      case 2: return new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB_PRE);
      case 3: return new BufferedImage(w, h, BufferedImage.TYPE_INT_BGR);
      case 4: return new BufferedImage(w, h, BufferedImage.TYPE_3BYTE_BGR);
      case 5: return new BufferedImage(w, h, BufferedImage.TYPE_4BYTE_ABGR);
      case 6: return new BufferedImage(w, h, BufferedImage.TYPE_4BYTE_ABGR_PRE);
      case 7: return new BufferedImage(w, h, BufferedImage.TYPE_BYTE_GRAY);
      case 8: return new BufferedImage(w, h, BufferedImage.TYPE_USHORT_565_RGB);
      case 9: return new BufferedImage(w, h, BufferedImage.TYPE_USHORT_555_RGB);
      case 10: return new BufferedImage(w, h, BufferedImage.TYPE_BYTE_INDEXED);
      case 11: return new BufferedImage(w, h, BufferedImage.TYPE_BYTE_BINARY);
      case 12: return new BufferedImage(w, h, BufferedImage.TYPE_BYTE_BINARY, palette(2));
      case 13: return new BufferedImage(w, h, BufferedImage.TYPE_BYTE_BINARY, palette(4));
      case 14: return new BufferedImage(w, h, BufferedImage.TYPE_USHORT_GRAY);
      default: throw new IllegalArgumentException();
    }
  }

  static IndexColorModel palette(int bits) {
    int n = 1 << bits;
    byte[] r = new byte[n], g = new byte[n], b = new byte[n];
    for (int i = 0; i < n; i++) {
      r[i] = (byte) (i * 255 / (n - 1));
      g[i] = (byte) ((i * 97 + 31) & 255);
      b[i] = (byte) (255 - i * 255 / (n - 1));
    }
    return new IndexColorModel(bits, n, r, g, b);
  }

  static final String[] NAMES = {"INT_ARGB", "INT_RGB", "INT_ARGB_PRE", "INT_BGR", "3BYTE_BGR", "4BYTE_ABGR", "4BYTE_ABGR_PRE", "BYTE_GRAY", "USHORT_565", "USHORT_555", "BYTE_INDEXED", "BINARY_1", "BINARY_2", "BINARY_4", "USHORT_GRAY"};

  static String crc(BufferedImage img) {
    CRC32 c = new CRC32();
    for (int y = 0; y < img.getHeight(); y++) {
      for (int x = 0; x < img.getWidth(); x++) {
        int p = img.getRGB(x, y);
        c.update(p >>> 24);
        c.update(p >> 16);
        c.update(p >> 8);
        c.update(p);
      }
    }
    return Long.toHexString(c.getValue());
  }

  static String raw(BufferedImage img) {
    CRC32 c = new CRC32();
    DataBuffer db = img.getRaster().getDataBuffer();
    for (int b = 0; b < db.getNumBanks(); b++) {
      for (int i = 0; i < db.getSize(); i++) {
        int v = db.getElem(b, i);
        c.update(v >>> 24);
        c.update(v >> 16);
        c.update(v >> 8);
        c.update(v);
      }
    }
    return Long.toHexString(c.getValue());
  }

  static BufferedImage base(int kind, int w, int h) {
    BufferedImage img = make(kind, w, h);
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        int a = ((x * 5 + y * 3) & 0x7f) + 0x60;
        img.setRGB(x, y, (a << 24) | ((x * 4) << 16) | ((y * 4) << 8) | ((x + y) * 2));
      }
    }
    return img;
  }

  static void print(String name, String type, BufferedImage img) {
    System.out.println(name + " " + type + " " + crc(img) + " " + raw(img));
  }

  static void scene(String name, Consumer<Graphics2D> draw) {
    for (int k = 0; k < NAMES.length; k++) {
      BufferedImage img = base(k, 48, 40);
      Graphics2D g = img.createGraphics();
      try {
        draw.accept(g);
      } catch (RuntimeException e) {
        System.out.println(name + " " + NAMES[k] + " " + e.getClass().getName());
      }
      g.dispose();
      print(name, NAMES[k], img);
    }
  }

  static BufferedImage source(int w, int h) {
    BufferedImage s = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) s.setRGB(x, y, ((x * 9 & 255) << 24) | ((x * 11) << 16) | ((y * 13) << 8) | (x ^ y) * 7);
    }
    return s;
  }

  static int sk;

  // the same scene with a source image of the destination's own type
  static void sameType(String name, Consumer<Graphics2D> draw) {
    for (int k = 0; k < NAMES.length; k++) {
      sk = k;
      BufferedImage img = base(k, 48, 40);
      Graphics2D g = img.createGraphics();
      draw.accept(g);
      g.dispose();
      print(name, NAMES[k], img);
    }
  }

  public static void main(String[] a) throws Exception {
    BufferedImage argb = source(20, 16);
    scene("xorFill", g -> { g.setXORMode(Color.CYAN); g.setColor(new Color(200, 30, 90)); g.fillRect(3, 4, 30, 20); g.fillRect(10, 10, 30, 20); });
    scene("xorLines", g -> { g.setXORMode(new Color(90, 200, 30)); g.setColor(Color.RED); g.drawLine(0, 0, 47, 39); g.drawLine(40, 2, 5, 30); g.drawLine(2, 20, 45, 22); g.drawLine(10, 0, 10, 39); g.drawLine(0, 0, 47, 39); });
    scene("xorRect", g -> { g.setXORMode(Color.WHITE); g.setColor(Color.BLUE); g.drawRect(2, 3, 30, 20); g.drawRect(-5, -5, 20, 20); g.drawRect(5, 5, 0, 0); g.drawRect(8, 8, 0, 12); g.drawRect(8, 8, 12, 0); });
    scene("xorPoly", g -> { g.setXORMode(Color.YELLOW); g.setColor(Color.GREEN); g.drawPolygon(new int[]{3, 40, 20, 8}, new int[]{3, 10, 35, 30}, 4); g.fillPolygon(new int[]{5, 42, 22}, new int[]{5, 12, 37}, 3); g.drawPolyline(new int[]{1, 10, 5, 30}, new int[]{30, 20, 38, 2}, 4); });
    scene("xorShapes", g -> { g.setXORMode(Color.MAGENTA); g.setColor(Color.ORANGE); g.fillOval(4, 4, 30, 25); g.drawOval(6, 8, 30, 20); g.fillArc(3, 3, 40, 30, 20, 220); g.fillRoundRect(2, 2, 30, 20, 8, 8); });
    scene("xorStroke", g -> { g.setXORMode(Color.LIGHT_GRAY); g.setColor(Color.RED); g.setStroke(new BasicStroke(4f)); g.drawLine(5, 5, 40, 30); g.draw(new Ellipse2D.Double(4, 4, 38, 30)); });
    scene("xorPath", g -> { g.setXORMode(Color.PINK); g.setColor(Color.BLUE); Path2D p = new Path2D.Double(Path2D.WIND_EVEN_ODD); p.moveTo(3, 3); p.lineTo(44, 10); p.lineTo(10, 36); p.lineTo(40, 36); p.lineTo(5, 12); p.closePath(); g.fill(p); g.draw(p); });
    scene("xorAlphaColor", g -> { g.setXORMode(Color.CYAN); g.setColor(new Color(10, 200, 100, 90)); g.fillRect(3, 4, 30, 20); g.drawLine(0, 5, 47, 30); });
    scene("xorClip", g -> { g.setXORMode(Color.RED); g.setClip(new Ellipse2D.Double(5, 5, 35, 28)); g.setColor(Color.BLUE); g.fillRect(0, 0, 48, 40); g.drawLine(0, 0, 47, 39); g.setClip(new Rectangle(8, 8, 20, 20)); g.drawRect(0, 0, 47, 39); });
    scene("xorImage", g -> { g.setXORMode(Color.CYAN); g.drawImage(argb, 3, 4, null); g.drawImage(argb, -5, 20, null); g.drawImage(argb, 30, 30, null); });
    scene("xorImageScaled", g -> { g.setXORMode(Color.RED); g.drawImage(argb, 3, 4, 30, 25, null); g.drawImage(argb, 20, 10, 10, 9, null); });
    scene("xorImageTransformed", g -> { g.setXORMode(Color.RED); g.rotate(0.4); g.drawImage(argb, 10, 3, null); });
    scene("xorTwice", g -> { g.setXORMode(Color.CYAN); for (int i = 0; i < 2; i++) { g.setColor(Color.RED); g.fillRect(5, 5, 20, 20); g.drawLine(0, 0, 40, 30); g.drawImage(argb, 8, 8, null); } });
    sameType("xorImageSame", g -> { BufferedImage s = base(sk, 20, 16); g.setXORMode(Color.CYAN); g.drawImage(s, 3, 4, null); g.drawImage(s, 30, 30, null); g.drawImage(s, 3, 4, 30, 25, null); });
    scene("xorModeBack", g -> { g.setXORMode(Color.CYAN); g.fillRect(3, 4, 30, 20); g.setPaintMode(); g.setColor(Color.RED); g.fillRect(10, 10, 10, 10); g.drawLine(0, 0, 47, 39); });

    scene("hugeLine1", g -> { g.setColor(Color.YELLOW); g.drawLine(0, 0, 1 << 29, 1 << 28); });
    scene("hugeLine2", g -> { g.setColor(Color.YELLOW); g.drawLine(-(1 << 30), -(1 << 30), 1 << 30, 1 << 30); g.drawLine(-MAX, 5, MAX, 30); g.drawLine(0, 40, MAX, -MAX); });
    scene("hugeLine3", g -> { g.setColor(Color.CYAN); g.drawLine(-100000, -77777, 100000, 90001); g.drawLine(3, -2000000, 40, 2000000); g.drawLine(-70000, 12, 70000, 20); g.drawLine(-(1 << 29), 3, 1 << 29, 38); });
    scene("hugeLine4", g -> { g.setColor(Color.ORANGE); g.drawLine(-(1 << 29) - 1000, -(1 << 29) + 5, (1 << 29) + 77, (1 << 29) + 91); g.drawLine(20, -(1 << 30) - 17, 30, (1 << 30) + 3); g.drawLine(-(1 << 31), 3, (1 << 31) - 1, 4); });
    scene("hugePolyline", g -> { g.setColor(Color.GREEN); g.drawPolyline(new int[]{-(1 << 29), 1 << 29, 5, MAX, 20}, new int[]{-(1 << 29), 1 << 28, 30, -MAX, 3}, 5); });
    scene("hugePolygon", g -> { g.setColor(Color.PINK); g.drawPolygon(new int[]{-(1 << 30), 1 << 30, 10}, new int[]{0, 1 << 30, -(1 << 30)}, 3); g.fillPolygon(new int[]{-(1 << 20), 1 << 20, 10}, new int[]{0, 1 << 20, -(1 << 20)}, 3); });
    scene("hugeLineXor", g -> { g.setXORMode(Color.RED); g.setColor(Color.YELLOW); g.drawLine(0, 0, 1 << 29, 1 << 28); g.drawLine(-(1 << 30), -(1 << 30), 1 << 30, 1 << 30); });
    scene("hugeLineClip", g -> { g.setClip(5, 5, 30, 20); g.setColor(Color.YELLOW); g.drawLine(-(1 << 29), -(1 << 28), 1 << 29, 1 << 28); g.drawLine(-100000, -77777, 100000, 90001); });
    scene("hugeStroke", g -> { g.setStroke(new BasicStroke(3f)); g.setColor(Color.YELLOW); g.drawLine(-(1 << 29), -(1 << 28), 1 << 29, 1 << 28); });

    scene("transPolyline", g -> { g.setColor(Color.YELLOW); g.translate(100, 0); g.drawPolyline(new int[]{0, MAX}, new int[]{5, 5}, 2); });
    scene("transPolyline2", g -> { g.setColor(Color.RED); g.translate(-100, 7); g.drawPolyline(new int[]{200, -MAX + 50, 30}, new int[]{3, 30, 20}, 3); g.translate(MAX - 10, MAX - 10); g.drawPolygon(new int[]{-MAX + 15, -MAX + 40, -MAX + 25}, new int[]{-MAX + 12, -MAX + 15, -MAX + 38}, 3); });
    scene("transLine", g -> { g.setColor(Color.RED); g.translate(MAX - 5, 3); g.drawLine(-MAX + 10, 4, -MAX + 40, 30); g.drawLine(-MAX + 40, 4, -MAX + 41, 4); });
    scene("transPolygon", g -> { g.setColor(Color.RED); g.translate(MAX - 5, MAX - 5); g.fillPolygon(new int[]{-MAX + 10, -MAX + 40, -MAX + 20}, new int[]{-MAX + 10, -MAX + 15, -MAX + 38}, 3); });

    scene("drawRectMax1", g -> { g.setColor(Color.RED); g.drawRect(0, 0, MAX, 5); });
    scene("drawRectMax2", g -> { g.setColor(Color.RED); g.drawRect(1, 1, MAX - 1, 5); });
    scene("drawRectMax3", g -> { g.setColor(Color.RED); g.drawRect(1, 1, 5, MAX - 1); });
    scene("drawRectMax4", g -> { g.setColor(Color.RED); g.drawRect(-5, -5, MAX, MAX); g.drawRect(2, 2, MAX - 3, 4); g.drawRect(MAX - 20, 3, 10, 10); g.drawRect(-MAX, -MAX, MAX, MAX); });
    scene("drawRectMax5", g -> { g.setColor(Color.RED); g.drawRect(3, 3, MAX - 10, 10); g.drawRect(0, 0, MAX - 1, 20); g.drawRect(-10, -10, 100, MAX - 5); });
    scene("fillRectMax", g -> { g.setColor(Color.RED); g.fillRect(5, 5, MAX, 5); g.fillRect(-MAX, -MAX, MAX, MAX); g.fillRect(20, 20, MAX, MAX); g.fillRect(MAX - 5, MAX - 5, 20, 20); });
    scene("drawRectMaxXor", g -> { g.setXORMode(Color.CYAN); g.setColor(Color.RED); g.drawRect(0, 0, MAX, 5); g.drawRect(-5, -5, MAX, MAX); g.drawRect(2, 2, 30, 20); });

    BufferedImage small = source(8, 8);
    scene("degenerate1", g -> { g.scale(1e-300, 1e-300); g.drawImage(argb, 3, 3, null); });
    scene("degenerate2", g -> { g.scale(1e300, 1e300); g.drawImage(argb, 3, 3, null); g.drawImage(small, 0, 0, null); });
    scene("degenerate3", g -> { g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR); g.scale(1e-300, 1e-300); g.drawImage(argb, 3, 3, null); });
    scene("degenerate4", g -> { g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC); g.scale(1e300, 1e-300); g.drawImage(small, 3, 3, null); });
    scene("degenerate5", g -> { g.setTransform(new AffineTransform(1e-200, 1e-200, 1e-200, 1e-200, 5, 5)); g.drawImage(argb, 0, 0, null); });
    scene("degenerate6", g -> { g.setTransform(new AffineTransform(1e10, 0, 0, 1e-10, 5, 5)); g.drawImage(small, 0, 0, null); g.setTransform(new AffineTransform(1e-10, 0, 0, 1e10, 5, 5)); g.drawImage(small, 0, 0, null); });
    scene("degenerate7", g -> { g.setTransform(new AffineTransform(Double.NaN, 0, 0, 1, 5, 5)); g.drawImage(argb, 0, 0, null); g.fillRect(0, 0, 5, 5); });
    scene("degenerate8", g -> { g.setTransform(new AffineTransform(Double.POSITIVE_INFINITY, 0, 0, 1, 5, 5)); g.drawImage(small, 0, 0, null); });
    scene("degenerate9", g -> { g.rotate(0.3); g.scale(1e-7, 1e-7); g.drawImage(argb, 3000000, 3000000, null); g.drawImage(small, -3000000, 20000000, 100, 100, null); });
    scene("degenerateScale", g -> { g.drawImage(argb, 3, 3, 1 << 30, 1 << 30, null); g.drawImage(argb, -(1 << 30), -(1 << 30), MAX, 1 << 30, null); g.drawImage(argb, 5, 5, 0, 7, null); g.drawImage(argb, 10, 10, -20, -9, null); });
    scene("hugeImageOffset", g -> { g.drawImage(argb, MAX - 2, 5, null); g.drawImage(argb, -MAX, 5, null); g.drawImage(argb, 5, MAX, null); g.drawImage(argb, MAX - 10, MAX - 10, 100, 100, null); });
  }
}
