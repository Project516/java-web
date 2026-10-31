import java.util.Random;

public class StringBuilders {
  static void show(String what, StringBuilder sb) {
    System.out.println(what + ": len=" + sb.length() + " cap=" + sb.capacity() + " [" + (sb.length() > 40 ? sb.substring(0, 40) + "..." : sb) + "]");
  }

  public static void main(String[] args) {
    StringBuilder sb = new StringBuilder();
    show("empty", sb);
    String[] parts = {"Parameter ", "object", " in method ", "register", "x".repeat(650), "", "tail"};
    for (String p : parts) {
      sb.append(p);
      show("append " + p.length(), sb);
    }
    String s = sb.toString();
    System.out.println(s.length() + " " + s.hashCode());

    StringBuilder n = new StringBuilder("a");
    String nul = null;
    n.append(nul).append((String) null);
    show("null", n);

    StringBuilder u = new StringBuilder("abc");
    u.append("中文");
    show("inflate", u);
    u.append("plain latin1");
    show("utf16 plus latin1", u);
    u.append("café");
    System.out.println(u + " " + u.toString().equals("abc中文plain latin1café"));

    StringBuilder c = new StringBuilder("中");
    c.append("abc");
    c.deleteCharAt(0);
    String compact = c.toString();
    System.out.println(compact + " " + compact.equals("abc") + " " + compact.hashCode() + " " + compact.concat("中").length());
    c.setCharAt(0, 'é');
    String latin = c.toString();
    System.out.println(latin + " " + latin.charAt(0) + " " + latin.toUpperCase());
    c.append('中');
    String wide = c.toString();
    System.out.println(wide.length() + " " + (int) wide.charAt(3) + " " + wide.codePointAt(3));

    StringBuffer buf = new StringBuffer();
    buf.append("one").append("中").append("two").append((String) null);
    System.out.println(buf + " " + buf.capacity());

    StringBuilder small = new StringBuilder(0);
    for (int i = 0; i < 10; i++) {
      small.append("ab");
      System.out.print(small.capacity() + " ");
    }
    System.out.println();

    StringBuilder big = new StringBuilder();
    String chunk = "0123456789abcdef".repeat(1000);
    for (int i = 0; i < 20; i++) big.append(chunk);
    System.out.println(big.length() + " " + big.capacity() + " " + big.toString().hashCode());

    Random r = new Random(7);
    String[] pool = {"", "a", "hello", "éè", "中文字", "mixed 中 text", "z".repeat(70), "w".repeat(300)};
    long sum = 0;
    for (int round = 0; round < 200; round++) {
      StringBuilder t = new StringBuilder(r.nextInt(4) == 0 ? 0 : 16);
      int k = r.nextInt(12);
      for (int i = 0; i < k; i++) {
        String p = pool[r.nextInt(pool.length)];
        if (r.nextInt(8) == 0) t.append((String) null); else t.append(p);
        if (r.nextInt(6) == 0) t.append((char) ('a' + r.nextInt(26)));
        if (r.nextInt(10) == 0 && t.length() > 0) t.deleteCharAt(r.nextInt(t.length()));
      }
      String out = t.toString();
      sum = sum * 31 + out.hashCode() + t.capacity() + out.length();
    }
    System.out.println(sum);
  }
}
