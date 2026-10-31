import java.awt.*;
import java.awt.geom.*;
import java.awt.image.*;
import java.util.function.Consumer;
import java.util.zip.CRC32;

// Graphics2D on the indexed, bit-packed and 16-bit gray image types, which
// HotSpot draws with their own native loops: shapes, alpha, anti-aliasing, XOR
// and drawImage between all types. Each scene prints a CRC32 of the getRGB
// pixels and one of the raw DataBuffer words, and both must equal HotSpot's.
public class Graphics2DTypes {
  static IndexColorModel palette(int bits, int mode) {
    int n = 1 << bits;
    byte[] r = new byte[n], g = new byte[n], b = new byte[n], a = new byte[n];
    for (int i = 0; i < n; i++) {
      r[i] = (byte) (i * 255 / (n - 1));
      g[i] = (byte) ((i * 97 + 31) & 255);
      b[i] = (byte) (255 - i * 255 / (n - 1));
      a[i] = (byte) (mode == 1 ? 40 + (i * 200 / n) : mode == 2 ? (i % 5 == 3 ? 0 : 255) : 255);
    }
    if (bits < 8 || mode != 0) {
      if (mode == 0) return new IndexColorModel(bits, n, r, g, b);
      return new IndexColorModel(bits, n, r, g, b, a);
    }
    return null;
  }

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
      case 11: { IndexColorModel m = palette(8, 1); return new BufferedImage(m, m.createCompatibleWritableRaster(w, h), false, null); }
      case 12: { IndexColorModel m = palette(8, 2); return new BufferedImage(m, m.createCompatibleWritableRaster(w, h), false, null); }
      case 13: return new BufferedImage(w, h, BufferedImage.TYPE_BYTE_BINARY);
      case 14: return new BufferedImage(w, h, BufferedImage.TYPE_BYTE_BINARY, palette(2, 0));
      case 15: return new BufferedImage(w, h, BufferedImage.TYPE_BYTE_BINARY, palette(4, 0));
      case 16: return new BufferedImage(w, h, BufferedImage.TYPE_USHORT_GRAY);
      default: throw new IllegalArgumentException();
    }
  }

  static final String[] NAMES = {"INT_ARGB", "INT_RGB", "INT_ARGB_PRE", "INT_BGR", "3BYTE_BGR", "4BYTE_ABGR", "4BYTE_ABGR_PRE", "BYTE_GRAY", "USHORT_565", "USHORT_555",
    "BYTE_INDEXED", "INDEXED_TRANSLUCENT", "INDEXED_BITMASK", "BINARY_1", "BINARY_2", "BINARY_4", "USHORT_GRAY"};
  // the ten common types are in Graphics2DEdges and Graphics2DShapes
  static final int[] NEW = {10, 11, 12, 13, 14, 15, 16};

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

  static void scene(String name, int[] kinds, Consumer<Graphics2D> draw) {
    for (int k : kinds) {
      BufferedImage img = base(k, 48, 40);
      Graphics2D g = img.createGraphics();
      draw.accept(g);
      g.dispose();
      print(name, NAMES[k], img);
    }
  }

  static BufferedImage argb(int w, int h) {
    BufferedImage s = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) s.setRGB(x, y, ((x * 9 & 255) << 24) | ((x * 11) << 16) | ((y * 13) << 8) | (x ^ y) * 7);
    }
    return s;
  }

  static void images(String name, int[] dests, int[] srcs, Consumer<Object[]> draw) {
    for (int d : dests) {
      for (int s : srcs) {
        BufferedImage dst = base(d, 40, 32), src = base(s, 20, 16);
        Graphics2D g = dst.createGraphics();
        draw.accept(new Object[] {g, src});
        g.dispose();
        print(name + "-" + NAMES[s], NAMES[d], dst);
      }
    }
  }

  static final int[] ALL = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16};
  static final int[] SRCS = {1, 0, 4, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16};

  public static void main(String[] a) throws Exception {
    scene("fillRect", NEW, g -> { g.setColor(new Color(200, 30, 90)); g.fillRect(3, 4, 20, 15); });
    scene("fillRectAlpha", NEW, g -> { g.setColor(new Color(200, 30, 90, 100)); g.fillRect(3, 4, 30, 25); });
    scene("drawLine", NEW, g -> { g.setColor(Color.YELLOW); g.drawLine(0, 0, 47, 39); g.drawLine(40, 2, 5, 30); g.drawLine(2, 20, 45, 22); g.drawLine(10, 0, 10, 39); });
    scene("drawRect", NEW, g -> { g.setColor(Color.CYAN); g.drawRect(2, 3, 30, 20); g.drawRect(-5, -5, 20, 20); });
    scene("fillOval", NEW, g -> { g.setColor(Color.ORANGE); g.fillOval(4, 4, 30, 25); });
    scene("fillOvalAA", NEW, g -> { g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON); g.setColor(new Color(10, 200, 100)); g.fillOval(4, 4, 30, 25); });
    scene("fillOvalAAAlpha", NEW, g -> { g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON); g.setColor(new Color(10, 200, 100, 120)); g.fillOval(4, 4, 30, 25); });
    scene("strokeWideAA", NEW, g -> { g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON); g.setStroke(new BasicStroke(5f)); g.setColor(Color.MAGENTA); g.drawLine(5, 5, 40, 30); g.draw(new Rectangle(8, 8, 25, 20)); });
    scene("dash", NEW, g -> { g.setStroke(new BasicStroke(3f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_BEVEL, 10f, new float[]{6f, 4f}, 0f)); g.setColor(Color.PINK); g.draw(new Ellipse2D.Double(4, 4, 38, 30)); });
    scene("fillPath", NEW, g -> { g.setColor(Color.GREEN); Path2D p = new Path2D.Double(Path2D.WIND_EVEN_ODD); p.moveTo(3, 3); p.lineTo(44, 10); p.lineTo(10, 36); p.lineTo(40, 36); p.lineTo(5, 12); p.closePath(); g.fill(p); });
    scene("clipRect", NEW, g -> { g.setClip(5, 5, 20, 20); g.setColor(Color.RED); g.fillRect(0, 0, 48, 40); g.setColor(Color.BLUE); g.drawLine(0, 0, 47, 39); });
    scene("clipShapeAA", NEW, g -> { g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON); g.setClip(new Ellipse2D.Double(5, 5, 35, 28)); g.setColor(new Color(255, 0, 0, 200)); g.fillRect(0, 0, 48, 40); });
    scene("transform", NEW, g -> { g.translate(10, 5); g.scale(0.8, 1.3); g.rotate(0.4); g.setColor(Color.LIGHT_GRAY); g.fillRect(3, 3, 20, 14); g.drawRect(2, 2, 22, 16); });
    scene("transformAA", NEW, g -> { g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON); g.translate(20, 5); g.rotate(0.5); g.setColor(Color.LIGHT_GRAY); g.fillRect(3, 3, 20, 14); g.drawRect(2, 2, 22, 16); });
    scene("compSrc", NEW, g -> { g.setComposite(AlphaComposite.getInstance(AlphaComposite.SRC, 0.5f)); g.setColor(new Color(255, 100, 0)); g.fillRect(4, 4, 30, 20); });
    scene("compClear", NEW, g -> { g.setComposite(AlphaComposite.Clear); g.fillRect(4, 4, 30, 20); });
    scene("compSrcOverEa", NEW, g -> { g.setComposite(AlphaComposite.getInstance(AlphaComposite.SRC_OVER, 0.4f)); g.setColor(new Color(0, 100, 255)); g.fillOval(4, 4, 38, 30); });
    scene("compRules", NEW, g -> { int[] r = {AlphaComposite.DST_OVER, AlphaComposite.SRC_IN, AlphaComposite.DST_OUT, AlphaComposite.SRC_ATOP, AlphaComposite.XOR}; for (int i = 0; i < r.length; i++) { g.setComposite(AlphaComposite.getInstance(r[i], 0.7f)); g.setColor(new Color(50 * i, 200, 20 * i, 180)); g.fillRect(i * 9, 3, 12, 30); } });
    scene("gradient", NEW, g -> { g.setPaint(new GradientPaint(0, 0, Color.RED, 47, 39, new Color(0, 0, 255, 128))); g.fillRect(2, 2, 44, 36); });
    scene("radialGradient", NEW, g -> { g.setPaint(new RadialGradientPaint(24, 20, 20, new float[]{0f, 1f}, new Color[]{Color.WHITE, new Color(0, 0, 0, 50)})); g.fillRect(0, 0, 48, 40); });
    scene("polygon", NEW, g -> { g.setColor(Color.GREEN); g.fillPolygon(new int[]{3, 40, 20, 8}, new int[]{3, 10, 35, 30}, 4); g.setColor(Color.RED); g.drawPolygon(new int[]{5, 42, 22}, new int[]{5, 12, 37}, 3); g.drawPolyline(new int[]{1, 10, 5, 30}, new int[]{30, 20, 38, 2}, 4); });
    scene("arcs", NEW, g -> { g.setColor(Color.ORANGE); g.fillArc(3, 3, 40, 30, 20, 220); g.setColor(Color.BLACK); g.drawArc(5, 5, 30, 28, 40, 200); g.fillRoundRect(2, 2, 30, 20, 8, 8); g.drawRoundRect(10, 10, 30, 22, 10, 6); });
    scene("grays", NEW, g -> { for (int i = 0; i < 12; i++) { g.setColor(new Color(i * 22, i * 22, i * 22)); g.fillRect(i * 4, 2, 4, 36); } for (int i = 0; i < 8; i++) { g.setColor(new Color(255, 255, 255, i * 30)); g.fillRect(2, i * 4 + 2, 44, 3); } });

    scene("xorFill", NEW, g -> { g.setXORMode(Color.CYAN); g.setColor(new Color(200, 30, 90)); g.fillRect(3, 4, 30, 20); g.fillRect(10, 10, 30, 20); });
    scene("xorLines", NEW, g -> { g.setXORMode(new Color(90, 200, 30)); g.setColor(Color.RED); g.drawLine(0, 0, 47, 39); g.drawLine(40, 2, 5, 30); g.drawLine(2, 20, 45, 22); g.drawLine(10, 0, 10, 39); g.drawRect(2, 3, 30, 20); g.drawRect(-5, -5, 20, 20); });
    scene("xorPoly", NEW, g -> { g.setXORMode(Color.YELLOW); g.setColor(Color.GREEN); g.drawPolygon(new int[]{3, 40, 20, 8}, new int[]{3, 10, 35, 30}, 4); g.fillPolygon(new int[]{5, 42, 22}, new int[]{5, 12, 37}, 3); g.fillOval(4, 4, 30, 25); });
    scene("xorClip", NEW, g -> { g.setXORMode(Color.RED); g.setClip(new Ellipse2D.Double(5, 5, 35, 28)); g.setColor(Color.BLUE); g.fillRect(0, 0, 48, 40); g.drawLine(0, 0, 47, 39); });
    BufferedImage s0 = argb(20, 16);
    scene("xorImage", NEW, g -> { g.setXORMode(Color.CYAN); g.drawImage(s0, 3, 4, null); g.drawImage(s0, -5, 20, null); g.drawImage(s0, 30, 30, null); });
    images("xorImageSrc", ALL, SRCS, o -> { Graphics2D g = (Graphics2D) o[0]; g.setXORMode(Color.CYAN); g.drawImage((BufferedImage) o[1], 3, 4, null); });

    images("drawImage", ALL, SRCS, o -> { Graphics2D g = (Graphics2D) o[0]; g.drawImage((BufferedImage) o[1], 3, 4, null); g.drawImage((BufferedImage) o[1], 25, 20, null); });
    images("drawImageBg", ALL, SRCS, o -> { Graphics2D g = (Graphics2D) o[0]; g.drawImage((BufferedImage) o[1], 3, 4, new Color(250, 120, 20), null); });
    images("drawImageScaled", ALL, SRCS, o -> { Graphics2D g = (Graphics2D) o[0]; g.drawImage((BufferedImage) o[1], 2, 3, 30, 22, null); g.drawImage((BufferedImage) o[1], 25, 20, 10, 9, null); });
    images("drawImageAlpha", ALL, SRCS, o -> { Graphics2D g = (Graphics2D) o[0]; g.setComposite(AlphaComposite.getInstance(AlphaComposite.SRC_OVER, 0.6f)); g.drawImage((BufferedImage) o[1], 3, 4, null); });
    images("drawImageSrcRule", ALL, SRCS, o -> { Graphics2D g = (Graphics2D) o[0]; g.setComposite(AlphaComposite.getInstance(AlphaComposite.SRC_IN)); g.drawImage((BufferedImage) o[1], 3, 4, null); });
    images("drawImageRotated", NEW, SRCS, o -> { Graphics2D g = (Graphics2D) o[0]; g.rotate(0.35); g.drawImage((BufferedImage) o[1], 10, 2, null); });
    images("drawImageBilinear", NEW, SRCS, o -> { Graphics2D g = (Graphics2D) o[0]; g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR); g.rotate(0.35); g.drawImage((BufferedImage) o[1], 10, 2, null); g.drawImage((BufferedImage) o[1], 0, 0, 33, 25, null); });
    images("drawImageBicubic", NEW, SRCS, o -> { Graphics2D g = (Graphics2D) o[0]; g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC); g.scale(1.3, 0.8); g.drawImage((BufferedImage) o[1], 4, 4, null); });
    images("drawImageClip", NEW, SRCS, o -> { Graphics2D g = (Graphics2D) o[0]; g.setClip(new Ellipse2D.Double(3, 3, 30, 24)); g.drawImage((BufferedImage) o[1], 0, 0, 40, 30, null); g.drawImage((BufferedImage) o[1], 6, 6, null); });

    // the pixel depth is the raster's sample size, whatever the palette size
    int[][] packed = {{1, 2}, {2, 2}, {2, 4}, {4, 2}, {4, 3}, {4, 4}, {4, 16}};
    for (int[] bs : packed) {
      int bits = bs[0], n = bs[1];
      byte[] r = new byte[n], g = new byte[n], b = new byte[n];
      for (int i = 0; i < n; i++) { r[i] = (byte) (i * 255 / (n - 1)); g[i] = (byte) ((i * 97 + 31) & 255); b[i] = (byte) (255 - i * 255 / (n - 1)); }
      IndexColorModel icm = new IndexColorModel(bits, n, r, g, b);
      BufferedImage img = new BufferedImage(icm, Raster.createPackedRaster(DataBuffer.TYPE_BYTE, 24, 10, 1, bits, null), false, null);
      Graphics2D g2 = img.createGraphics();
      g2.setColor(new Color(200, 30, 90));
      g2.fillRect(3, 2, 15, 6);
      g2.setColor(new Color(20, 220, 130));
      g2.drawLine(0, 0, 23, 9);
      g2.dispose();
      print("packed" + bits + "x" + n, "PACKED", img);
    }
  }
}
