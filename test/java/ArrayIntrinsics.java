import java.util.Arrays;
import java.util.Random;

// Arrays.mismatch, Arrays.equals, hashCode and UTF-8 decoding over the array intrinsics.
public class ArrayIntrinsics {
    public static void main(String[] args) {
        Random r = new Random(7);
        int sum = 0;
        for (int len = 0; len < 70; len++) {
            for (int diff = -1; diff < len; diff++) {
                byte[] a = new byte[len], b;
                r.nextBytes(a);
                b = a.clone();
                if (diff >= 0) b[diff] ^= 0x40;
                sum += Arrays.mismatch(a, b) * 31 + Arrays.hashCode(a) + Boolean.hashCode(Arrays.equals(a, b));
                short[] s = new short[len], u;
                for (int i = 0; i < len; i++) s[i] = (short) r.nextInt();
                u = s.clone();
                if (diff >= 0) u[diff]++;
                sum += Arrays.mismatch(s, u) * 17 + Arrays.hashCode(s);
                char[] c = new char[len], d;
                for (int i = 0; i < len; i++) c[i] = (char) r.nextInt();
                d = c.clone();
                if (diff >= 0) d[diff]++;
                sum += Arrays.mismatch(c, d) * 13 + Arrays.hashCode(c);
                int[] x = new int[len], y;
                for (int i = 0; i < len; i++) x[i] = r.nextInt();
                y = x.clone();
                if (diff >= 0) y[diff]--;
                sum += Arrays.mismatch(x, y) * 11 + Arrays.hashCode(x);
                long[] p = new long[len], q;
                for (int i = 0; i < len; i++) p[i] = r.nextLong();
                q = p.clone();
                if (diff >= 0) q[diff]++;
                sum += Arrays.mismatch(p, q) * 7;
            }
        }
        System.out.println(sum);
        String latin = "café plain ascii text", wide = "中文 text é";
        System.out.println(latin.hashCode() + " " + wide.hashCode() + " " + "".hashCode());
        System.out.println(Arrays.mismatch(new byte[100], 10, 90, new byte[100], 0, 80));
        byte[] utf8 = "ascii only then é non ascii".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        System.out.println(new String(utf8, java.nio.charset.StandardCharsets.UTF_8));
        System.out.println(new String(new byte[] {65, 66, 67}, java.nio.charset.StandardCharsets.UTF_8));
        System.out.println(new String(new byte[] {65, (byte) 0xff, 67}, java.nio.charset.StandardCharsets.UTF_8).length());
    }
}
