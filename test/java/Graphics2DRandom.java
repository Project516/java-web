import java.awt.*;
import java.awt.geom.*;
import java.awt.image.*;
import java.util.Random;
import java.util.zip.CRC32;

// Seeded random drawing: fills, lines, shapes, strokes, images, gradients,
// every alpha composite rule, antialiasing, transforms and clips, on each
// image type. Prints a CRC of the pixels and of the raw data buffer per seed
// and type, so a mismatch names the seed and type.
public class Graphics2DRandom {
  static final int[] TYPES = {
    BufferedImage.TYPE_INT_ARGB, BufferedImage.TYPE_INT_RGB, BufferedImage.TYPE_INT_ARGB_PRE, BufferedImage.TYPE_INT_BGR,
    BufferedImage.TYPE_3BYTE_BGR, BufferedImage.TYPE_4BYTE_ABGR, BufferedImage.TYPE_4BYTE_ABGR_PRE, BufferedImage.TYPE_BYTE_GRAY,
    BufferedImage.TYPE_USHORT_565_RGB, BufferedImage.TYPE_USHORT_555_RGB};
  static final int[] SOURCE_TYPES = {
    BufferedImage.TYPE_INT_ARGB, BufferedImage.TYPE_INT_RGB, BufferedImage.TYPE_INT_ARGB_PRE, BufferedImage.TYPE_3BYTE_BGR,
    BufferedImage.TYPE_BYTE_GRAY, BufferedImage.TYPE_4BYTE_ABGR};

  public static void main(String[] args) {
    for (int seed = 1; seed <= 3; seed++) {
      for (int type : TYPES) draw(seed, type, 50);
    }
  }

  static void draw(int seed, int type, int ops) {
    Random r = new Random(seed * 31L + type);
    BufferedImage img = new BufferedImage(40, 32, type);
    BufferedImage[] sources = new BufferedImage[SOURCE_TYPES.length];
    for (int i = 0; i < sources.length; i++) {
      sources[i] = new BufferedImage(14, 11, SOURCE_TYPES[i]);
      for (int y = 0; y < 11; y++) {
        for (int x = 0; x < 14; x++) sources[i].setRGB(x, y, r.nextInt());
      }
    }
    for (int y = 0; y < 32; y++) {
      for (int x = 0; x < 40; x++) img.setRGB(x, y, r.nextInt());
    }
    Graphics2D g = img.createGraphics();
    for (int i = 0; i < ops; i++) {
      g.setTransform(new AffineTransform());
      g.setClip(null);
      g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, r.nextBoolean() ? RenderingHints.VALUE_ANTIALIAS_ON : RenderingHints.VALUE_ANTIALIAS_OFF);
      Object interpolation = r.nextInt(3) == 0 ? RenderingHints.VALUE_INTERPOLATION_BILINEAR
          : r.nextInt(2) == 0 ? RenderingHints.VALUE_INTERPOLATION_BICUBIC : RenderingHints.VALUE_INTERPOLATION_NEAREST_NEIGHBOR;
      g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, interpolation);
      int rule = 1 + r.nextInt(12);
      if (rule == AlphaComposite.DST) rule = AlphaComposite.SRC_OVER;
      g.setComposite(AlphaComposite.getInstance(rule, r.nextInt(4) == 0 ? 1f : r.nextFloat()));
      g.setColor(new Color(r.nextInt(), true));
      if (r.nextInt(3) == 0) g.translate(r.nextInt(10) - 5, r.nextInt(10) - 5);
      if (r.nextInt(3) == 0) {
        g.rotate(r.nextDouble() * 6);
        g.scale(0.5 + r.nextDouble() * 1.5, 0.5 + r.nextDouble() * 1.5);
      }
      if (r.nextInt(4) == 0) g.setClip(r.nextInt(5), r.nextInt(5), 5 + r.nextInt(30), 5 + r.nextInt(25));
      else if (r.nextInt(5) == 0) g.setClip(new Ellipse2D.Double(r.nextInt(10), r.nextInt(10), 10 + r.nextInt(25), 10 + r.nextInt(20)));
      if (r.nextInt(3) == 0) g.setStroke(new BasicStroke(0.5f + r.nextFloat() * 6, r.nextInt(3), r.nextInt(3)));
      int x = r.nextInt(30) - 5, y = r.nextInt(25) - 5;
      switch (r.nextInt(9)) {
        case 0 -> g.fillRect(x, y, r.nextInt(30), r.nextInt(25));
        case 1 -> g.drawLine(x, y, r.nextInt(50) - 5, r.nextInt(40) - 5);
        case 2 -> g.fillOval(x, y, r.nextInt(30), r.nextInt(25));
        case 3 -> g.drawRect(x, y, r.nextInt(30), r.nextInt(25));
        case 4 -> g.drawImage(sources[r.nextInt(sources.length)], x, y, null);
        case 5 -> g.drawImage(sources[r.nextInt(sources.length)], x, y, 4 + r.nextInt(40), 4 + r.nextInt(35), null);
        case 6 -> {
          Path2D p = new Path2D.Double();
          p.moveTo(r.nextInt(40), r.nextInt(30));
          for (int k = 0; k < 4; k++) {
            if (r.nextBoolean()) p.lineTo(r.nextInt(40), r.nextInt(30));
            else p.quadTo(r.nextInt(40), r.nextInt(30), r.nextInt(40), r.nextInt(30));
          }
          p.closePath();
          if (r.nextBoolean()) g.fill(p);
          else g.draw(p);
        }
        case 7 -> {
          g.setPaint(new GradientPaint(r.nextInt(40), r.nextInt(30), new Color(r.nextInt(), true),
              r.nextInt(40), r.nextInt(30), new Color(r.nextInt(), true), r.nextBoolean()));
          g.fillRect(0, 0, 40, 32);
        }
        default -> g.drawImage(sources[r.nextInt(sources.length)], x, y, r.nextInt(4) == 0 ? new Color(r.nextInt(), true) : null, null);
      }
    }
    g.dispose();
    CRC32 pixels = new CRC32(), raw = new CRC32();
    for (int y = 0; y < 32; y++) {
      for (int x = 0; x < 40; x++) update(pixels, img.getRGB(x, y));
    }
    DataBuffer db = img.getRaster().getDataBuffer();
    for (int i = 0; i < db.getSize(); i++) update(raw, db.getElem(i));
    System.out.printf("seed %d type %d pixels %08x raw %08x%n", seed, type, pixels.getValue(), raw.getValue());
  }

  static void update(CRC32 c, int v) {
    c.update(v >>> 24);
    c.update(v >> 16);
    c.update(v >> 8);
    c.update(v);
  }
}
