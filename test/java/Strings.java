import java.util.*;
import java.util.regex.*;

public class Strings {
    public static void main(String[] args) {
        String s = "Hello, Wörld! 世界 😀";
        System.out.println(s + " " + s.length() + " " + s.codePointCount(0, s.length()));
        System.out.println(s.toUpperCase() + " " + s.toLowerCase());
        System.out.println(String.join("|", "a,b,,c".split(",")));
        System.out.println("  trim me ".strip() + "." + " x ".trim() + ".");
        System.out.println(String.format("%5d|%-5s|%08.3f|%x|%c|%b|%e", 42, "ab", 3.14159, 255, 'z', true, 12345.678));
        System.out.println(String.valueOf(new char[] {'c', 'h'}) + " " + "abc".repeat(2) + " " + "abcdef".substring(2, 4));
        double[] ds = {0.1, 1.0 / 3, 1e10, 1e-5, 100.0, Double.MAX_VALUE, Double.MIN_VALUE, -0.0, Double.NaN, 1e21, 123456789.125};
        for (double d : ds) System.out.print(d + " ");
        System.out.println();
        float[] fs = {0.1f, 1.0f / 3, 3.4e38f, 1e-10f};
        for (float f : fs) System.out.print(f + " ");
        System.out.println();
        System.out.println(Integer.toBinaryString(-8) + " " + Long.toHexString(-1L) + " " + Integer.parseInt("-123") + " " + Long.parseLong("9223372036854775807"));
        System.out.println(Double.parseDouble("2.5e3") + " " + Float.parseFloat("1.1") + " " + Integer.MAX_VALUE + 1);
        Matcher m = Pattern.compile("(\\w+)@(\\w+)\\.com").matcher("mail bob@example.com and amy@test.com");
        while (m.find()) System.out.println(m.group(1) + " at " + m.group(2));
        System.out.println("a1b22c333".replaceAll("[0-9]+", "#"));
        StringBuilder sb = new StringBuilder("abc");
        sb.insert(0, 12).append(3.5).append('x').reverse().setCharAt(0, 'Z');
        System.out.println(sb + " " + sb.indexOf("c"));
        String block = """
            Text block
              indented "quotes"
            end""";
        System.out.println(block);
        System.out.println("compare " + "apple".compareTo("banana") + " " + "a".equalsIgnoreCase("A") + " " + "hash".hashCode());
        char[] cs = "dcba".toCharArray();
        Arrays.sort(cs);
        System.out.println(new String(cs) + " " + "x".isEmpty() + " " + " ".isBlank());
        System.out.println(String.valueOf((Object) null) + " " + Character.isLetter('é') + " " + Character.toUpperCase('ß') + " " + Character.getNumericValue('7'));
        System.out.println("lines: " + "a\nb\nc".lines().count() + " " + "%s-%s".formatted("x", "y"));
        byte[] utf8 = s.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        System.out.println(utf8.length + " " + new String(utf8, java.nio.charset.StandardCharsets.UTF_8).equals(s));
        System.out.println(String.CASE_INSENSITIVE_ORDER.compare("ABC", "abd"));
    }
}
