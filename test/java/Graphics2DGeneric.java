import java.awt.*;
import java.awt.color.ColorSpace;
import java.awt.image.*;

// Image types and color models that java-web draws with the JDK's general Java
// loops, here next to the types that have native loops: only exact colors are
// compared, since rounding of blended and dithered pixels can differ.
public class Graphics2DGeneric {
  public static void main(String[] args) {
    int[] types = {BufferedImage.TYPE_BYTE_INDEXED, BufferedImage.TYPE_BYTE_BINARY, BufferedImage.TYPE_USHORT_GRAY};
    String[] names = {"BYTE_INDEXED", "BYTE_BINARY", "USHORT_GRAY"};
    BufferedImage[] images = new BufferedImage[types.length + 1];
    for (int i = 0; i < types.length; i++) images[i] = new BufferedImage(40, 30, types[i]);
    ColorModel cm = new ComponentColorModel(ColorSpace.getInstance(ColorSpace.CS_GRAY), true, false, Transparency.TRANSLUCENT, DataBuffer.TYPE_BYTE);
    images[types.length] = new BufferedImage(cm, Raster.createInterleavedRaster(DataBuffer.TYPE_BYTE, 40, 30, 2, null), false, null);
    names = new String[] {names[0], names[1], names[2], "CUSTOM_GRAY_ALPHA"};
    for (int i = 0; i < images.length; i++) {
      BufferedImage img = images[i];
      Graphics2D g = img.createGraphics();
      g.setColor(Color.BLACK);
      g.fillRect(0, 0, 40, 30);
      g.setColor(Color.WHITE);
      g.fillRect(2, 3, 10, 8);
      g.drawLine(0, 20, 39, 25);
      g.fillOval(18, 2, 16, 14);
      g.setClip(new Rectangle(0, 0, 30, 30));
      g.drawRect(5, 14, 12, 10);
      g.setClip(null);
      g.scale(0.5, 0.5);
      g.fillRect(40, 40, 20, 12);
      g.dispose();
      BufferedImage copy = new BufferedImage(40, 30, img.getType() == 0 ? BufferedImage.TYPE_INT_ARGB : img.getType());
      Graphics2D cg = copy.createGraphics();
      cg.drawImage(img, 0, 0, null);
      cg.drawImage(img, 4, 4, 20, 15, null);
      cg.dispose();
      StringBuilder sb = new StringBuilder(names[i]);
      for (int[] p : new int[][] {{0, 0}, {5, 5}, {25, 8}, {10, 21}, {35, 25}, {25, 25}, {12, 14}, {22, 22}, {22, 26}}) {
        sb.append(String.format(" %08x/%08x", img.getRGB(p[0], p[1]), copy.getRGB(p[0], p[1])));
      }
      System.out.println(sb);
    }
  }
}
