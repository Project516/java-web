import java.io.ByteArrayOutputStream;
import java.util.zip.Deflater;
import java.util.zip.Inflater;

public class DeflaterLateDictionary {
  static byte[] data(int n, int seed) {
    byte[] b = new byte[n];
    int s = seed;
    for (int i = 0; i < n; i++) {
      s = s * 1103515245 + 12345;
      b[i] = (byte) ('a' + (s >>> 16) % 12);
    }
    return b;
  }

  public static void main(String[] args) throws Exception {
    byte[] dict = data(5000, 1), tail = data(8000, 3), buf = new byte[65536];
    int[] strategies = { Deflater.DEFAULT_STRATEGY, Deflater.FILTERED, Deflater.HUFFMAN_ONLY };
    // level 0 is left out: HotSpot drops held stored input there
    for (int level = 1; level <= 9; level++) {
      for (int strategy : strategies) {
        for (int n : new int[] { 1, 300, 70000 }) {
          byte[] head = data(n, 2);
          byte[] want = new byte[n + tail.length];
          System.arraycopy(head, 0, want, 0, n);
          System.arraycopy(tail, 0, want, n, tail.length);

          Deflater def = new Deflater(level, true);
          def.setStrategy(strategy);
          ByteArrayOutputStream z = new ByteArrayOutputStream();
          def.setInput(head);
          while (!def.needsInput()) z.write(buf, 0, def.deflate(buf, 0, buf.length, Deflater.NO_FLUSH));
          String set;
          try {
            def.setDictionary(dict);
            set = "accepted";
          } catch (IllegalArgumentException e) {
            set = "refused";
          }
          def.setInput(tail);
          def.finish();
          while (!def.finished()) z.write(buf, 0, def.deflate(buf, 0, buf.length));
          def.end();

          Inflater inf = new Inflater(true);
          if (set.equals("accepted")) inf.setDictionary(dict);
          inf.setInput(z.toByteArray());
          ByteArrayOutputStream got = new ByteArrayOutputStream();
          while (!inf.finished()) {
            int k = inf.inflate(buf);
            if (k == 0 && inf.needsInput()) break;
            got.write(buf, 0, k);
          }
          inf.end();
          System.out.println("level " + level + " strategy " + strategy + " n " + n + " " + set
              + " inflated " + got.size() + " equal " + java.util.Arrays.equals(got.toByteArray(), want));
        }
      }
    }
  }
}
