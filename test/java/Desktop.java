import java.awt.Color;
import java.awt.geom.AffineTransform;
import java.awt.geom.Line2D;
import java.awt.geom.Path2D;
import java.awt.geom.Point2D;
import java.awt.geom.Rectangle2D;
import java.awt.image.BufferedImage;
import java.beans.Introspector;
import java.beans.PropertyChangeSupport;
import java.beans.PropertyDescriptor;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.xpath.XPathFactory;
import org.w3c.dom.Document;

// The headless parts of java.desktop that libraries use (2D geometry,
// colors, images, JavaBeans), and java.xml, which java.desktop requires.
public class Desktop {
  public static class Bean {
    private double speed;
    public double getSpeed() { return speed; }
    public void setSpeed(double s) { speed = s; }
  }

  public static void main(String[] args) throws Exception {
    // GraphicsEnvironment.isHeadless reads the environment
    System.out.println("env " + System.getenv("JAVA_WEB_UNSET"));
    Point2D a = new Point2D.Double(1, 2), b = new Point2D.Double(4, 6);
    System.out.println("distance " + a.distance(b));
    Line2D l1 = new Line2D.Double(0, 0, 10, 10), l2 = new Line2D.Double(0, 10, 10, 0);
    System.out.println("intersects " + l1.intersectsLine(l2) + ", ptLineDist " + l1.ptLineDist(10, 0));
    AffineTransform t = AffineTransform.getRotateInstance(Math.PI / 2);
    Point2D r = t.transform(new Point2D.Double(1, 0), null);
    System.out.printf("rotated %.3f %.3f%n", r.getX(), r.getY());
    Rectangle2D box = new Rectangle2D.Double(0, 0, 2, 3);
    System.out.println("box " + box.contains(1, 1) + " " + box.createUnion(new Rectangle2D.Double(5, 5, 1, 1)));
    Path2D.Double tri = new Path2D.Double();
    tri.moveTo(0, 0); tri.lineTo(4, 0); tri.lineTo(0, 4); tri.closePath();
    System.out.println("path " + tri.contains(1, 1) + " " + tri.contains(3, 3) + " " + tri.getBounds2D());

    Color c = new Color(10, 20, 30, 40);
    System.out.println("color " + c + " " + Integer.toHexString(c.getRGB()) + " " + Color.decode("#ff8800").brighter());
    float[] hsb = Color.RGBtoHSB(255, 128, 0, null);
    System.out.printf("hsb %.3f %.3f %.3f%n", hsb[0], hsb[1], hsb[2]);

    BufferedImage img = new BufferedImage(4, 3, BufferedImage.TYPE_INT_ARGB);
    img.setRGB(1, 2, 0x80ff0000);
    System.out.println("image " + img.getWidth() + "x" + img.getHeight() + " " + Integer.toHexString(img.getRGB(1, 2)) + " " + img.getRGB(0, 0));

    PropertyChangeSupport changes = new PropertyChangeSupport(new Object());
    changes.addPropertyChangeListener(e -> System.out.println("changed " + e.getPropertyName() + " " + e.getOldValue() + " -> " + e.getNewValue()));
    changes.firePropertyChange("speed", 1.0, 2.5);
    PropertyDescriptor[] props = Introspector.getBeanInfo(Bean.class, Object.class).getPropertyDescriptors();
    System.out.println("bean " + Arrays.stream(props).map(p -> p.getName() + ":" + p.getPropertyType()).toList());

    String xml = "<device><motor id=\"1\" speed=\"0.5\"/><motor id=\"2\" speed=\"0.75\"/></device>";
    Document doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(new ByteArrayInputStream(xml.getBytes(StandardCharsets.UTF_8)));
    System.out.println("xml " + doc.getDocumentElement().getTagName() + " " + doc.getElementsByTagName("motor").getLength()
        + " " + XPathFactory.newInstance().newXPath().evaluate("sum(/device/motor/@speed)", doc));
  }
}
