import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.util.Arrays;
import java.util.zip.Adler32;
import java.util.zip.CRC32;
import java.util.zip.DataFormatException;
import java.util.zip.Deflater;
import java.util.zip.DeflaterOutputStream;
import java.util.zip.Inflater;
import java.util.zip.InflaterInputStream;

// Deflater and Inflater streams: round trips, flushes and preset dictionaries.
// Compressed bytes may differ from zlib's, so only decompressed results print.
public class ZipStreams {
  public static void main(String[] args) throws Exception {
    byte[] data = new byte[8 << 20];
    long seed = 42;
    for (int i = 0; i < data.length; i++) {
      seed = seed * 6364136223846793005L + 1442695040888963407L;
      data[i] = (byte) (i % 7 == 0 ? seed >>> 59 : 'a' + i % 26);
    }

    // a small output buffer, so the deflater must wait for the stream to drain
    ByteArrayOutputStream packed = new ByteArrayOutputStream();
    try (DeflaterOutputStream out = new DeflaterOutputStream(packed, new Deflater(), 512, true)) {
      for (int off = 0; off < data.length; off += 300_000) {
        out.write(data, off, Math.min(300_000, data.length - off));
        out.flush();
      }
    }
    byte[] back = new InflaterInputStream(new ByteArrayInputStream(packed.toByteArray())).readAllBytes();
    CRC32 crc = new CRC32();
    crc.update(back);
    System.out.println("round trip " + back.length + " crc " + Long.toHexString(crc.getValue()) + " same " + Arrays.equals(data, back));

    byte[] dict = "hello dictionary".getBytes();
    Adler32 dictAdler = new Adler32();
    dictAdler.update(dict);
    Deflater def = new Deflater();
    def.setDictionary(dict);
    System.out.println("deflater adler is dictionary " + (def.getAdler() == (int) dictAdler.getValue()));
    def.setInput(Arrays.copyOf(data, 5000));
    def.finish();
    byte[] buf = new byte[20000];
    int n = def.deflate(buf);
    System.out.println("finished " + def.finished());
    try {
      def.setDictionary(dict);
      System.out.println("no exception");
    } catch (IllegalArgumentException e) {
      System.out.println("late dictionary: " + e.getClass().getName());
    }

    Inflater inf = new Inflater();
    inf.setInput(buf, 0, n);
    byte[] out = new byte[5000];
    System.out.println("inflated before dictionary " + inf.inflate(out) + " needs " + inf.needsDictionary()
        + " id matches " + (inf.getAdler() == (int) dictAdler.getValue()));
    try {
      inf.setDictionary("wrong".getBytes());
      System.out.println("no exception");
    } catch (IllegalArgumentException e) {
      System.out.println("wrong dictionary: " + e.getClass().getName());
    }
    inf.setDictionary(dict);
    int got = inf.inflate(out);
    System.out.println("inflated " + got + " finished " + inf.finished() + " same " + Arrays.equals(out, Arrays.copyOf(data, 5000)));

    Deflater raw = new Deflater(Deflater.DEFAULT_COMPRESSION, true);
    raw.setInput(Arrays.copyOf(data, 1000));
    raw.finish();
    n = raw.deflate(buf);
    Inflater rawInf = new Inflater(true);
    rawInf.setInput(buf, 0, n);
    try {
      System.out.println("raw inflated " + rawInf.inflate(out) + " finished " + rawInf.finished());
    } catch (DataFormatException e) {
      System.out.println("raw: " + e);
    }
  }
}
