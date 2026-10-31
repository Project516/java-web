// Code javac builds with a StringBuilder chain must give the same strings once it is compiled.
// javac: -XDstringConcat=inline
public class StringConcat {
  static final String LATIN = "café ÿ";
  static final String WIDE = "漢字 😀";

  static String pair(String a, String b) { return a + b; }
  static String three(String a, String b, String c) { return a + "|" + b + "<>" + c; }
  static String literals(String a) { return "[" + a + "]" + "" + a + "end"; }
  static String twice(String a) { return a + a + a; }
  static String branch(String a, boolean flag) { return a + (flag ? "yes" : "no") + "!"; }
  static String withInt(String a, int i) { return a + i + "x"; }
  static String guarded(String a, String b) {
    try {
      return "<" + a + b + ">";
    } catch (RuntimeException e) {
      return "caught";
    }
  }
  static String viaPair(String a, String b) { return pair(pair(a, "-"), b); }

  static String check(String s) {
    return s.length() + ":" + s.hashCode() + ":" + (s.isEmpty() ? "" : s.substring(0, Math.min(8, s.length())));
  }

  public static void main(String[] args) {
    String big = "0123456789".repeat(300);
    String[] pieces = {"", "a", LATIN, WIDE, null, big, "tail"};
    long total = 0;
    for (int i = 0; i < 6000; i++) {
      String a = pieces[i % pieces.length], b = pieces[(i / 7) % pieces.length], c = pieces[(i * 3) % pieces.length];
      String p = pair(a, b), t = three(a, b, c), l = literals(a), w = twice(b);
      String br = branch(a, (i & 1) == 0), n = withInt(c, i), g = guarded(a, b), v = viaPair(a, c);
      total += p.length() + t.length() + l.length() + w.length() + br.length() + n.length() + g.length() + v.length();
      total += p.hashCode() ^ t.hashCode() ^ l.hashCode() ^ w.hashCode() ^ br.hashCode() ^ n.hashCode() ^ g.hashCode() ^ v.hashCode();
      if (!p.equals(a + "" + b) && a != null && b != null) System.out.println("mismatch " + i);
    }
    System.out.println(total);
    for (String a : pieces) {
      for (String b : pieces) {
        System.out.println(check(pair(a, b)) + " " + check(three(a, b, a)) + " " + check(twice(a)) + " " + check(viaPair(a, b)));
      }
      System.out.println(check(literals(a)) + " " + check(branch(a, true)) + " " + check(withInt(a, 42)) + " " + check(guarded(a, a)));
    }
    String latin = pair(LATIN, "x"), wide = pair(WIDE, LATIN), mixed = pair(LATIN, WIDE);
    System.out.println(latin + " " + wide + " " + mixed);
    System.out.println(pair("", "").isEmpty() + " " + pair(null, null) + " " + three(null, "", null));
    System.out.println(pair("a", "b") == "ab");
    System.out.println(pair("a", "b").equals("ab") + " " + pair("a", "b").intern().equals("ab") + " " + (pair("a", "b").intern() == "ab"));
    System.out.println(pair(WIDE, "").equals(WIDE) + " " + pair("", LATIN).equals(LATIN) + " " + pair(LATIN, "").equals(LATIN));
    char[] chars = pair(LATIN, WIDE).toCharArray();
    int sum = 0;
    for (char ch : chars) sum += ch;
    System.out.println(chars.length + " " + sum);
    System.out.println(pair(big, big).length() + " " + three(big, big, big).length() + " " + twice(big).hashCode());
  }
}
