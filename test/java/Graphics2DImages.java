import java.awt.*;
import java.awt.geom.*;
import java.awt.image.*;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.util.function.Consumer;
import java.util.zip.CRC32;
import javax.imageio.ImageIO;

// Graphics2D on BufferedImage: every scene is drawn on each image type and
// printed as a CRC32 of all getRGB pixels plus three sample pixels. The
// types with native loops in HotSpot must match it pixel for pixel.
public class Graphics2DImages {
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
    scene("drawImage", g -> { BufferedImage s = base(BufferedImage.TYPE_INT_ARGB, 20, 16); g.drawImage(s, 5, 6, null); g.drawImage(s, 30, 20, 10, 8, null); });
    scene("drawImageRGB", g -> { BufferedImage s = base(BufferedImage.TYPE_INT_RGB, 20, 16); g.drawImage(s, 5, 6, null); g.drawImage(s, 26, 20, 18, 14, null); });
    scene("drawImageBg", g -> { BufferedImage s = base(BufferedImage.TYPE_INT_ARGB, 20, 16); g.drawImage(s, 5, 6, Color.BLUE, null); });
    scene("drawImageAlpha", g -> { g.setComposite(AlphaComposite.getInstance(AlphaComposite.SRC_OVER, 0.5f)); BufferedImage s = base(BufferedImage.TYPE_INT_ARGB, 20, 16); g.drawImage(s, 5, 6, null); g.drawImage(s, 20, 15, 25, 20, null); });
    scene("drawImageSrcTypes", g -> { int k = 0; for (int t : new int[]{BufferedImage.TYPE_INT_ARGB_PRE, BufferedImage.TYPE_3BYTE_BGR, BufferedImage.TYPE_BYTE_GRAY, BufferedImage.TYPE_4BYTE_ABGR, BufferedImage.TYPE_INT_BGR, BufferedImage.TYPE_USHORT_565_RGB}) { g.drawImage(base(t, 8, 6), (k % 4) * 11, (k / 4) * 9, null); k++; } });
    scene("drawImageNN", g -> { BufferedImage s = base(BufferedImage.TYPE_INT_ARGB, 13, 11); g.drawImage(s, 3, 3, 40, 33, null); g.drawImage(s, 40, 30, 5, 5, null); g.drawImage(s, 20, 20, 3, 4, 20, 20, 20, 20, null); });
    scene("drawImageBilinear", g -> { g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR); BufferedImage s = base(BufferedImage.TYPE_INT_ARGB, 13, 11); g.drawImage(s, 3, 3, 40, 33, null); });
    scene("drawImageBicubic", g -> { g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC); BufferedImage s = base(BufferedImage.TYPE_INT_RGB, 13, 11); g.drawImage(s, 3, 3, 30, 25, null); });
    scene("drawImageXform", g -> { BufferedImage s = base(BufferedImage.TYPE_INT_ARGB, 16, 12); g.drawImage(s, AffineTransform.getRotateInstance(0.5, 20, 5), null); });
    scene("drawImageXformBil", g -> { g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR); BufferedImage s = base(BufferedImage.TYPE_INT_ARGB, 16, 12); AffineTransform at = AffineTransform.getRotateInstance(0.5, 20, 5); at.scale(1.4, 1.2); g.drawImage(s, at, null); });
    scene("copyArea", g -> { g.setColor(Color.WHITE); g.fillRect(2, 2, 10, 10); g.copyArea(0, 0, 20, 20, 8, 6); g.copyArea(10, 10, 20, 20, -4, -3); });
    scene("subimage", g -> { BufferedImage sub = base(type, 30, 30).getSubimage(5, 6, 18, 14); Graphics2D g2 = sub.createGraphics(); g2.setColor(Color.RED); g2.fillRect(2, 2, 10, 8); g2.drawLine(0, 0, 17, 13); g2.dispose(); g.drawImage(sub, 4, 4, null); });
    scene("bufferedOp", g -> { BufferedImage s = base(BufferedImage.TYPE_INT_ARGB, 16, 12); g.drawImage(s, new AffineTransformOp(AffineTransform.getScaleInstance(1.5, 1.3), AffineTransformOp.TYPE_BILINEAR), 4, 4); });
    scene("rescale", g -> { BufferedImage s = base(BufferedImage.TYPE_INT_RGB, 16, 12); g.drawImage(s, new RescaleOp(0.7f, 20f, null), 4, 4); });
    scene("lookup", g -> { byte[] t = new byte[256]; for (int i = 0; i < 256; i++) t[i] = (byte) (255 - i); BufferedImage s = base(BufferedImage.TYPE_INT_RGB, 16, 12); g.drawImage(s, new LookupOp(new ByteLookupTable(0, t), null), 4, 4); });
    scene("drawImageFlip", g -> { BufferedImage s = base(BufferedImage.TYPE_INT_ARGB, 16, 12); g.drawImage(s, 40, 4, 24, 4, 16, 0, 0, 12, null); g.drawImage(s, 5, 5, 8, 12, 0, 0, 16, 12, Color.RED, null); });
    scene("drawImageXformClip", g -> { g.setClip(new Ellipse2D.Double(5, 3, 38, 34)); BufferedImage s = base(BufferedImage.TYPE_INT_ARGB, 16, 12); g.drawImage(s, AffineTransform.getRotateInstance(0.4, 20, 10), null); });

    // ImageIO writes the drawn image as PNG and reads it back unchanged
    for (int t : new int[] {BufferedImage.TYPE_INT_ARGB, BufferedImage.TYPE_INT_RGB, BufferedImage.TYPE_BYTE_GRAY}) {
      BufferedImage img = base(t, 48, 40);
      Graphics2D g = img.createGraphics();
      g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
      g.setColor(Color.RED);
      g.fillOval(3, 3, 30, 28);
      g.dispose();
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      ImageIO.write(img, "png", out);
      byte[] png = out.toByteArray();
      BufferedImage back = ImageIO.read(new ByteArrayInputStream(png));
      System.out.printf("png %d signature %02x%02x%02x%02x ihdr %dx%d depth %d round trip %b%n", t, png[0], png[1], png[2], png[3],
          back.getWidth(), back.getHeight(), back.getColorModel().getPixelSize(), crc(back).equals(crc(img)));
    }
  }
}
