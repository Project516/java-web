import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.UUID;

// MD5 at block boundaries, split updates and name-based UUIDs (the MD5 intrinsic).
public class Md5Digest {
  static final HexFormat HEX = HexFormat.of();

  static byte[] data(int n) {
    byte[] b = new byte[n];
    for (int i = 0; i < n; i++) b[i] = (byte) (i * 131 + (i >> 8) + 17);
    return b;
  }

  public static void main(String[] args) throws Exception {
    MessageDigest md = MessageDigest.getInstance("MD5");
    System.out.println("empty " + HEX.formatHex(md.digest()));
    System.out.println("abc " + HEX.formatHex(md.digest("abc".getBytes(StandardCharsets.US_ASCII))));
    for (int n : new int[] {1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 1000000}) {
      System.out.println(n + " " + HEX.formatHex(md.digest(data(n))));
    }

    byte[] big = data(100000);
    int[][] splits = {{1, 7, 63, 65, 3}, {13, 64, 129, 5}, {0, 1, 0, 2}, {4096, 31, 4097}};
    for (int[] split : splits) {
      int pos = 0;
      while (pos < big.length) {
        for (int s : split) {
          int len = Math.min(s, big.length - pos);
          md.update(big, pos, len);
          pos += len;
        }
      }
      System.out.println("split " + HEX.formatHex(md.digest()));
    }
    md.update(big, 3, 99997);
    System.out.println("offset " + HEX.formatHex(md.digest()));

    byte[] first = new byte[16];
    for (int i = 0; i < 5; i++) {
      md.update(first);
      first = md.digest();
    }
    System.out.println("chain " + HEX.formatHex(first));

    for (String s : new String[] {"", "a", "hello", "java-web", "the quick brown fox jumps over the lazy dog", "é中😀"}) {
      System.out.println("uuid " + UUID.nameUUIDFromBytes(s.getBytes(StandardCharsets.UTF_8)));
    }
  }
}
