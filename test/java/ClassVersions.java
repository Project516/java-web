import java.io.InputStream;
import java.util.Arrays;

// Class file headers that must be refused, with HotSpot's exact errors.
public class ClassVersions extends ClassLoader {
  static byte[] header(int major, int minor) {
    return new byte[] {(byte) 0xca, (byte) 0xfe, (byte) 0xba, (byte) 0xbe,
        (byte) (minor >> 8), (byte) minor, (byte) (major >> 8), (byte) major};
  }

  void tryDefine(String what, byte[] b) {
    try {
      defineClass("Probe", b, 0, b.length);
      System.out.println(what + ": defined");
    } catch (Throwable e) {
      System.out.println(what + ": " + e);
    }
  }

  public static void main(String[] args) throws Exception {
    ClassVersions l = new ClassVersions();
    l.tryDefine("70.0", header(70, 0));
    l.tryDefine("69.1", header(69, 1));
    l.tryDefine("69.65535", header(69, 65535));
    l.tryDefine("68.65535", header(68, 65535));
    l.tryDefine("44.0", header(44, 0));
    l.tryDefine("69.0 truncated", header(69, 0));
    byte[] bad = header(69, 0);
    bad[0] = 0;
    l.tryDefine("bad magic", bad);
    byte[] real;
    try (InputStream in = ClassVersions.class.getResourceAsStream("ClassVersions$Probe.class")) {
      real = in.readAllBytes();
    }
    byte[] longer = Arrays.copyOf(real, real.length + 1);
    try {
      l.defineClass("ClassVersions$Probe", longer, 0, longer.length);
    } catch (Throwable e) {
      System.out.println("extra byte: " + e);
    }
  }

  static class Probe {}
}
