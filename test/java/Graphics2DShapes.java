import java.awt.*;
import java.awt.geom.*;
import java.awt.image.*;
import java.util.function.Consumer;
import java.util.zip.CRC32;

// Graphics2D on BufferedImage: every scene is drawn on each image type and
// printed as a CRC32 of all getRGB pixels plus three sample pixels. The
// types with native loops in HotSpot must match it pixel for pixel.
public class Graphics2DShapes {
  static final int[] TYPES = {
    BufferedImage.TYPE_INT_ARGB, BufferedImage.TYPE_INT_RGB, BufferedImage.TYPE_INT_ARGB_PRE, BufferedImage.TYPE_INT_BGR,
    BufferedImage.TYPE_3BYTE_BGR, BufferedImage.TYPE_4BYTE_ABGR, BufferedImage.TYPE_4BYTE_ABGR_PRE, BufferedImage.TYPE_BYTE_GRAY,
    BufferedImage.TYPE_USHORT_565_RGB, BufferedImage.TYPE_USHORT_555_RGB};
  static final String[] NAMES = {"INT_ARGB", "INT_RGB", "INT_ARGB_PRE", "INT_BGR", "3BYTE_BGR", "4BYTE_ABGR", "4BYTE_ABGR_PRE", "BYTE_GRAY", "USHORT_565", "USHORT_555"};

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

  static BufferedImage base(int type, int w, int h) {
    BufferedImage img = new BufferedImage(w, h, type);
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        int a = ((x * 5 + y * 3) & 0x7f) + 0x60;
        img.setRGB(x, y, (a << 24) | ((x * 4) << 16) | ((y * 4) << 8) | ((x + y) * 2));
      }
    }
    return img;
  }

  static int type;

  static void scene(String name, Consumer<Graphics2D> draw) {
    for (int i = 0; i < TYPES.length; i++) {
      type = TYPES[i];
      BufferedImage img = base(type, 48, 40);
      Graphics2D g = img.createGraphics();
      draw.accept(g);
      g.dispose();
      System.out.printf("%s %s %s %08x %08x %08x%n", name, NAMES[i], crc(img), img.getRGB(3, 4), img.getRGB(20, 18), img.getRGB(44, 36));
    }
  }

  public static void main(String[] a) throws Exception {
    scene("fillRect", g -> { g.setColor(new Color(200, 30, 90)); g.fillRect(3, 4, 20, 15); });
    scene("fillRectAlpha", g -> { g.setColor(new Color(200, 30, 90, 100)); g.fillRect(3, 4, 30, 25); });
    scene("drawLine", g -> { g.setColor(Color.YELLOW); g.drawLine(0, 0, 47, 39); g.drawLine(40, 2, 5, 30); g.drawLine(2, 20, 45, 22); g.drawLine(10, 0, 10, 39); });
    scene("drawRect", g -> { g.setColor(Color.CYAN); g.drawRect(2, 3, 30, 20); g.drawRect(-5, -5, 20, 20); });
    scene("fillOval", g -> { g.setColor(Color.ORANGE); g.fillOval(4, 4, 30, 25); });
    scene("fillOvalAA", g -> { g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON); g.setColor(new Color(10, 200, 100)); g.fillOval(4, 4, 30, 25); });
    scene("fillOvalAAAlpha", g -> { g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON); g.setColor(new Color(10, 200, 100, 120)); g.fillOval(4, 4, 30, 25); });
    scene("strokeWide", g -> { g.setStroke(new BasicStroke(5f)); g.setColor(Color.MAGENTA); g.drawLine(5, 5, 40, 30); g.draw(new Rectangle(8, 8, 25, 20)); });
    scene("strokeWideAA", g -> { g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON); g.setStroke(new BasicStroke(5f)); g.setColor(Color.MAGENTA); g.drawLine(5, 5, 40, 30); g.draw(new Rectangle(8, 8, 25, 20)); });
    scene("dash", g -> { g.setStroke(new BasicStroke(3f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_BEVEL, 10f, new float[]{6f, 4f}, 0f)); g.setColor(Color.PINK); g.draw(new Ellipse2D.Double(4, 4, 38, 30)); });
    scene("dashAA", g -> { g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON); g.setStroke(new BasicStroke(3f, BasicStroke.CAP_SQUARE, BasicStroke.JOIN_MITER, 10f, new float[]{6f, 4f}, 2f)); g.setColor(Color.PINK); g.draw(new Rectangle2D.Double(4.5, 4.5, 38, 30)); });
    scene("drawShapeThin", g -> { g.setColor(Color.WHITE); Path2D p = new Path2D.Double(); p.moveTo(3, 3); p.curveTo(40, 0, 10, 40, 44, 36); p.quadTo(30, 20, 5, 35); p.closePath(); g.draw(p); });
    scene("fillPath", g -> { g.setColor(Color.GREEN); Path2D p = new Path2D.Double(Path2D.WIND_EVEN_ODD); p.moveTo(3, 3); p.lineTo(44, 10); p.lineTo(10, 36); p.lineTo(40, 36); p.lineTo(5, 12); p.closePath(); g.fill(p); });
    scene("clipRect", g -> { g.setClip(5, 5, 20, 20); g.setColor(Color.RED); g.fillRect(0, 0, 48, 40); g.setColor(Color.BLUE); g.drawLine(0, 0, 47, 39); });
    scene("clipShape", g -> { g.setClip(new Ellipse2D.Double(5, 5, 35, 28)); g.setColor(Color.RED); g.fillRect(0, 0, 48, 40); });
    scene("clipShapeAA", g -> { g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON); g.setClip(new Ellipse2D.Double(5, 5, 35, 28)); g.setColor(new Color(255, 0, 0, 200)); g.fillRect(0, 0, 48, 40); });
    scene("transform", g -> { g.translate(10, 5); g.scale(0.8, 1.3); g.rotate(0.4); g.setColor(Color.LIGHT_GRAY); g.fillRect(3, 3, 20, 14); g.drawRect(2, 2, 22, 16); });
    scene("transformAA", g -> { g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON); g.translate(20, 5); g.rotate(0.5); g.setColor(Color.LIGHT_GRAY); g.fillRect(3, 3, 20, 14); g.drawRect(2, 2, 22, 16); });
    scene("compSrc", g -> { g.setComposite(AlphaComposite.getInstance(AlphaComposite.SRC, 0.5f)); g.setColor(new Color(255, 100, 0)); g.fillRect(4, 4, 30, 20); });
    scene("compClear", g -> { g.setComposite(AlphaComposite.Clear); g.fillRect(4, 4, 30, 20); });
    scene("compSrcOverEa", g -> { g.setComposite(AlphaComposite.getInstance(AlphaComposite.SRC_OVER, 0.4f)); g.setColor(new Color(0, 100, 255)); g.fillOval(4, 4, 38, 30); });
    scene("compRules", g -> { int[] r = {AlphaComposite.DST_OVER, AlphaComposite.SRC_IN, AlphaComposite.DST_OUT, AlphaComposite.SRC_ATOP, AlphaComposite.XOR}; for (int i = 0; i < r.length; i++) { g.setComposite(AlphaComposite.getInstance(r[i], 0.7f)); g.setColor(new Color(50 * i, 200, 20 * i, 180)); g.fillRect(i * 9, 3, 12, 30); } });
    scene("gradient", g -> { g.setPaint(new GradientPaint(0, 0, Color.RED, 47, 39, new Color(0, 0, 255, 128))); g.fillRect(2, 2, 44, 36); });
    scene("gradientCyclic", g -> { g.setPaint(new GradientPaint(5, 5, Color.YELLOW, 20, 12, Color.BLACK, true)); g.fillOval(2, 2, 44, 36); });
    scene("linearGradient", g -> { g.setPaint(new LinearGradientPaint(0, 0, 47, 0, new float[]{0f, 0.3f, 1f}, new Color[]{Color.RED, Color.GREEN, Color.BLUE})); g.fillRect(2, 2, 44, 36); });
    scene("radialGradient", g -> { g.setPaint(new RadialGradientPaint(24, 20, 20, new float[]{0f, 1f}, new Color[]{Color.WHITE, new Color(0, 0, 0, 50)})); g.fillRect(0, 0, 48, 40); });
    scene("texture", g -> { BufferedImage t = new BufferedImage(6, 6, BufferedImage.TYPE_INT_ARGB); for (int i = 0; i < 6; i++) for (int j = 0; j < 6; j++) t.setRGB(i, j, ((i + j) % 2 == 0) ? 0xff2080ff : 0x80ff8020); g.setPaint(new TexturePaint(t, new Rectangle2D.Double(1, 2, 6, 6))); g.fillRect(2, 2, 44, 36); });
    scene("polygon", g -> { g.setColor(Color.GREEN); g.fillPolygon(new int[]{3, 40, 20, 8}, new int[]{3, 10, 35, 30}, 4); g.setColor(Color.RED); g.drawPolygon(new int[]{5, 42, 22}, new int[]{5, 12, 37}, 3); g.drawPolyline(new int[]{1, 10, 5, 30}, new int[]{30, 20, 38, 2}, 4); });
    scene("arcs", g -> { g.setColor(Color.ORANGE); g.fillArc(3, 3, 40, 30, 20, 220); g.setColor(Color.BLACK); g.drawArc(5, 5, 30, 28, 40, 200); g.fillRoundRect(2, 2, 30, 20, 8, 8); g.drawRoundRect(10, 10, 30, 22, 10, 6); g.drawOval(6, 8, 30, 20); });
    scene("joins", g -> { for (int j = 0; j < 3; j++) { g.setStroke(new BasicStroke(4f, BasicStroke.CAP_BUTT, j, 4f)); g.setColor(new Color(60 * j, 100, 200)); Path2D p = new Path2D.Double(); p.moveTo(3 + 14 * j, 30); p.lineTo(10 + 14 * j, 5); p.lineTo(17 + 14 * j, 30); g.draw(p); } });
    scene("joinsAA", g -> { g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON); for (int j = 0; j < 3; j++) { g.setStroke(new BasicStroke(4f, BasicStroke.CAP_ROUND, j, 4f)); g.setColor(new Color(60 * j, 100, 200)); Path2D p = new Path2D.Double(); p.moveTo(3 + 14 * j, 30); p.lineTo(10 + 14 * j, 5); p.lineTo(17 + 14 * j, 30); g.draw(p); } });
    scene("strokePure", g -> { g.setRenderingHint(RenderingHints.KEY_STROKE_CONTROL, RenderingHints.VALUE_STROKE_PURE); g.draw(new Ellipse2D.Double(3.3, 4.2, 30.5, 20.7)); g.fill(new RoundRectangle2D.Double(10.5, 12.5, 20, 20, 5, 5)); });
    scene("rotClip", g -> { g.rotate(0.3); g.setClip(new Rectangle(5, 5, 25, 20)); g.setColor(Color.PINK); g.fillRect(0, 0, 48, 40); });
  }
}
