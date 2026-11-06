import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.util.Arrays;
import java.util.Random;
import java.util.zip.DataFormatException;
import java.util.zip.Deflater;
import java.util.zip.DeflaterOutputStream;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;
import java.util.zip.Inflater;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

public class DeflaterLevels {
  static final String[] WORDS = {"alpha", "beta", "gamma", "delta", "class", "public", "static", "void", "return", "String"};

  static byte[] text(int n, long seed) {
    Random r = new Random(seed);
    StringBuilder sb = new StringBuilder();
    while (sb.length() < n) sb.append(WORDS[r.nextInt(WORDS.length)]).append(r.nextInt(5) == 0 ? "\n" : " ");
    return Arrays.copyOf(sb.toString().getBytes(), n);
  }

  static byte[] noise(int n, long seed) {
    byte[] b = new byte[n];
    new Random(seed).nextBytes(b);
    return b;
  }

  static byte[] inflate(byte[] z, boolean nowrap, byte[] dict, int size) throws DataFormatException {
    Inflater inf = new Inflater(nowrap);
    inf.setInput(z);
    byte[] out = new byte[size + 10];
    int n = 0;
    while (!inf.finished()) {
      int k = inf.inflate(out, n, out.length - n);
      if (k == 0 && inf.needsDictionary()) inf.setDictionary(dict);
      else if (k == 0 && (inf.needsInput() || n == out.length)) break;
      n += k;
    }
    boolean done = inf.finished();
    inf.end();
    return done ? Arrays.copyOf(out, n) : null;
  }

  static byte[] compress(byte[] data, int level, int strategy, boolean nowrap, int step, int outSize) {
    Deflater d = new Deflater(level, nowrap);
    d.setStrategy(strategy);
    ByteArrayOutputStream bo = new ByteArrayOutputStream();
    byte[] buf = new byte[outSize];
    for (int at = 0; at < data.length; at += step) {
      d.setInput(data, at, Math.min(step, data.length - at));
      while (!d.needsInput()) bo.write(buf, 0, d.deflate(buf));
    }
    d.finish();
    while (!d.finished()) bo.write(buf, 0, d.deflate(buf));
    d.end();
    return bo.toByteArray();
  }

  static void levels() throws Exception {
    byte[][] inputs = {new byte[0], {7}, text(100000, 1), noise(70000, 2), new byte[150000], text(30000, 3)};
    String[] names = {"empty", "one", "text", "noise", "zeros", "short"};
    for (int i = 0; i < inputs.length; i++) {
      for (int level = -1; level <= 9; level++) {
        for (int strategy = 0; strategy <= 2; strategy++) {
          boolean nowrap = (level + strategy) % 2 != 0;
          byte[] z = compress(inputs[i], level, strategy, nowrap, 1 << 20, 4096);
          byte[] back = inflate(z, nowrap, null, inputs[i].length);
          boolean ok = back != null && Arrays.equals(back, inputs[i]);
          boolean small = level != 0 && inputs[i].length > 1000 && i != 3 && z.length < inputs[i].length;
          if (!ok || (level != 0 && i != 3 && inputs[i].length > 1000 && !small)) {
            System.out.println("FAIL " + names[i] + " level " + level + " strategy " + strategy);
          }
        }
      }
      System.out.println(names[i] + ": all levels and strategies round-trip");
    }
    byte[] data = text(200000, 4);
    System.out.println("small buffers: " + Arrays.equals(inflate(compress(data, 6, 0, false, 777, 5), false, null, data.length), data));
    System.out.println("level 0 header: " + hex(compress(data, 0, 0, false, 1 << 20, 4096), 2));
    System.out.println("level 1 header: " + hex(compress(data, 1, 0, false, 1 << 20, 4096), 2));
    System.out.println("level 4 header: " + hex(compress(data, 4, 0, false, 1 << 20, 4096), 2));
    System.out.println("level 6 header: " + hex(compress(data, 6, 0, false, 1 << 20, 4096), 2));
    System.out.println("level 9 header: " + hex(compress(data, 9, 0, false, 1 << 20, 4096), 2));
    System.out.println("huffman only header: " + hex(compress(data, 9, Deflater.HUFFMAN_ONLY, false, 1 << 20, 4096), 2));
    byte[] big = compress(data, 6, 0, false, 1 << 20, 4096);
    System.out.println("level 6 shrinks text: " + (big.length < data.length / 2));
    System.out.println("huffman only shrinks text: "
        + (compress(data, 6, Deflater.HUFFMAN_ONLY, true, 1 << 20, 4096).length < data.length * 3 / 4));
  }

  static String hex(byte[] b, int n) {
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < n && i < b.length; i++) sb.append(String.format("%02x", b[i] & 0xff));
    return sb.toString();
  }

  static void flushes() throws Exception {
    byte[] data = text(60000, 5);
    for (int level : new int[] {0, 1, 6, 9}) {
      for (int mode : new int[] {Deflater.SYNC_FLUSH, Deflater.FULL_FLUSH}) {
        Deflater d = new Deflater(level, true);
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[100];
        boolean markers = true;
        for (int at = 0; at < data.length; at += 7000) {
          d.setInput(data, at, Math.min(7000, data.length - at));
          int k;
          while ((k = d.deflate(buf, 0, buf.length, mode)) > 0) bo.write(buf, 0, k);
          byte[] sofar = bo.toByteArray();
          int n = sofar.length;
          markers &= n >= 4 && sofar[n - 4] == 0 && sofar[n - 3] == 0 && sofar[n - 2] == -1 && sofar[n - 1] == -1;
          Inflater inf = new Inflater(true);
          inf.setInput(sofar);
          byte[] back = new byte[data.length];
          int got = 0, m;
          while ((m = inf.inflate(back, got, back.length - got)) > 0) got += m;
          markers &= got == Math.min(at + 7000, data.length) && Arrays.equals(Arrays.copyOf(back, got), Arrays.copyOf(data, got));
          inf.end();
        }
        d.finish();
        int k;
        while (!d.finished()) {
          k = d.deflate(buf);
          bo.write(buf, 0, k);
        }
        d.end();
        boolean ok = Arrays.equals(inflate(bo.toByteArray(), true, null, data.length), data);
        System.out.println("level " + level + " flush " + mode + ": markers " + markers + ", round-trip " + ok);
      }
    }
  }

  static void params() throws Exception {
    byte[] data = text(120000, 6);
    Deflater d = new Deflater(Deflater.BEST_SPEED);
    ByteArrayOutputStream bo = new ByteArrayOutputStream();
    byte[] buf = new byte[300];
    int[] levels = {1, 9, 0, 6, 3};
    int[] strategies = {0, 0, 0, Deflater.FILTERED, Deflater.HUFFMAN_ONLY};
    int part = data.length / levels.length;
    for (int i = 0; i < levels.length; i++) {
      d.setLevel(levels[i]);
      d.setStrategy(strategies[i]);
      d.setInput(data, i * part, part);
      while (!d.needsInput()) bo.write(buf, 0, d.deflate(buf));
    }
    d.finish();
    while (!d.finished()) bo.write(buf, 0, d.deflate(buf));
    long in = d.getBytesRead();
    d.end();
    System.out.println("parameter changes: read " + in + ", round-trip "
        + Arrays.equals(inflate(bo.toByteArray(), false, null, data.length), Arrays.copyOf(data, part * levels.length)));
  }

  static void dictionary() throws Exception {
    byte[] dict = text(20000, 7);
    byte[] data = Arrays.copyOfRange(dict, 5000, 15000);
    for (boolean nowrap : new boolean[] {false, true}) {
      Deflater d = new Deflater(6, nowrap);
      d.setDictionary(dict);
      d.setInput(data);
      d.finish();
      byte[] buf = new byte[1000];
      int n = d.deflate(buf);
      byte[] z = Arrays.copyOf(buf, n);
      Inflater inf = new Inflater(nowrap);
      inf.setInput(z);
      byte[] back = new byte[data.length];
      if (nowrap) inf.setDictionary(dict);
      int got = inf.inflate(back);
      if (!nowrap && got == 0 && inf.needsDictionary()) {
        inf.setDictionary(dict);
        got = inf.inflate(back);
      }
      System.out.println("dictionary nowrap=" + nowrap + ": finished " + d.finished() + ", uses it " + (n < 200)
          + ", round-trip " + (got == data.length && Arrays.equals(back, data)));
      d.end();
      inf.end();
    }
  }

  static void streams() throws Exception {
    byte[] data = text(250000, 8);
    ByteArrayOutputStream bo = new ByteArrayOutputStream();
    try (GZIPOutputStream g = new GZIPOutputStream(bo)) {
      g.write(data, 0, 100000);
      g.write(data, 100000, 150000);
    }
    byte[] gz = bo.toByteArray();
    try (GZIPInputStream in = new GZIPInputStream(new ByteArrayInputStream(gz))) {
      System.out.println("gzip: header " + hex(gz, 3) + ", round-trip " + Arrays.equals(in.readAllBytes(), data)
          + ", shrinks " + (gz.length < data.length / 2));
    }
    bo.reset();
    try (GZIPOutputStream g = new GZIPOutputStream(bo, 512, true)) {
      g.write(data, 0, 5000);
      g.flush();
      System.out.println("gzip flush emits data: " + (bo.size() > 10));
      g.write(data, 5000, 5000);
    }
    try (GZIPInputStream in = new GZIPInputStream(new ByteArrayInputStream(bo.toByteArray()))) {
      System.out.println("gzip sync flush: " + Arrays.equals(in.readAllBytes(), Arrays.copyOf(data, 10000)));
    }
    bo.reset();
    Deflater fast = new Deflater(Deflater.BEST_COMPRESSION);
    try (DeflaterOutputStream out = new DeflaterOutputStream(bo, fast)) {
      for (int i = 0; i < data.length; i += 1000) out.write(data, i, Math.min(1000, data.length - i));
    }
    fast.end();
    System.out.println("deflater stream: " + Arrays.equals(inflate(bo.toByteArray(), false, null, data.length), data));

    bo.reset();
    try (ZipOutputStream zo = new ZipOutputStream(bo)) {
      for (int i = 0; i < 3; i++) {
        ZipEntry e = new ZipEntry("e" + i + ".txt");
        zo.putNextEntry(e);
        zo.write(data, i * 1000, 90000);
        zo.closeEntry();
        System.out.println("zip entry " + i + ": size " + e.getSize() + ", smaller " + (e.getCompressedSize() < e.getSize()));
      }
    }
    try (ZipInputStream zi = new ZipInputStream(new ByteArrayInputStream(bo.toByteArray()))) {
      ZipEntry e;
      int i = 0;
      while ((e = zi.getNextEntry()) != null) {
        System.out.println(e.getName() + ": " + Arrays.equals(zi.readAllBytes(), Arrays.copyOfRange(data, i * 1000, i * 1000 + 90000)));
        i++;
      }
    }
  }

  static void firstCall() {
    Deflater d = new Deflater();
    byte[] buf = new byte[64];
    System.out.println("first call, no input: " + d.deflate(buf));
    System.out.println("needsInput: " + d.needsInput());
    d.setInput(new byte[] {1, 2, 3, 4});
    System.out.println("with input, no flush: " + d.deflate(buf));
    d.finish();
    int n = d.deflate(buf);
    System.out.println("finish: " + n + " " + d.finished() + " " + hex(Arrays.copyOfRange(buf, 0, n), 2));
    d.reset();
    d.setInput(new byte[0]);
    d.finish();
    n = d.deflate(buf);
    System.out.println("empty stream: " + n + " " + hex(buf, n) + " " + d.finished());
    d.end();
    Deflater raw = new Deflater(Deflater.DEFAULT_COMPRESSION, true);
    raw.finish();
    n = raw.deflate(buf);
    System.out.println("empty raw stream: " + n + " " + hex(buf, n));
    raw.end();
    for (int bad : new int[] {10, -2}) {
      try {
        new Deflater(bad);
        System.out.println("level " + bad + " accepted");
      } catch (IllegalArgumentException e) {
        System.out.println("level " + bad + ": IllegalArgumentException");
      }
    }
  }

  public static void main(String[] args) throws Exception {
    levels();
    flushes();
    params();
    dictionary();
    streams();
    firstCall();
  }
}
