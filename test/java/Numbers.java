import java.math.*;
import java.util.*;

public class Numbers {
    public static void main(String[] args) {
        int i = Integer.MAX_VALUE;
        System.out.println((i + 1) + " " + (i * 2) + " " + (-7 / 2) + " " + (-7 % 2) + " " + (Integer.MIN_VALUE / -1) + " " + (7 >>> 1) + " " + (-7 >> 1) + " " + (-7 >>> 28));
        long l = Long.MAX_VALUE;
        System.out.println((l + 1) + " " + (l * 3) + " " + (-7L / 2) + " " + (-7L % 2) + " " + (1L << 63) + " " + (-1L >>> 1) + " " + (-1L >> 70) + " " + Long.MIN_VALUE / -1);
        System.out.println((byte) 200 + " " + (short) 70000 + " " + (char) 65 + " " + (int) 'z' + " " + (int) 3.99 + " " + (int) -3.99 + " " + (long) 1e30 + " " + (int) Double.NaN + " " + (int) Float.POSITIVE_INFINITY);
        System.out.println(0.1 + 0.2 + " " + (0.1f + 0.2f) + " " + 1.0 / 0 + " " + -1.0 / 0 + " " + 0.0 / 0 + " " + (float) 1e40 + " " + 5 % 3.5 + " " + -5.5f % 2);
        // HotSpot's x86-64 stubs for pow, sin, cos, tan, exp, log and log10 may differ from StrictMath by 1 ulp
        System.out.println(Math.sqrt(2) + " " + StrictMath.pow(2, 0.5) + " " + StrictMath.sin(1) + " " + StrictMath.cos(1) + " " + StrictMath.tan(1) + " " + Math.atan2(1, 2));
        System.out.println(StrictMath.exp(1) + " " + StrictMath.log(10) + " " + StrictMath.log10(1000) + " " + Math.cbrt(27) + " " + Math.hypot(3, 4) + " " + Math.floorMod(-7, 3) + " " + Math.round(-2.5) + " " + Math.round(2.5f));
        System.out.println(Math.abs(Integer.MIN_VALUE) + " " + Math.max(1.0, -0.0) + " " + Math.min(-0.0, 0.0) + " " + Math.ceil(-0.5) + " " + Math.floor(-0.5) + " " + Math.rint(2.5) + " " + Math.signum(-3.0));
        System.out.println(Integer.bitCount(255) + " " + Long.numberOfTrailingZeros(64) + " " + Integer.reverse(1) + " " + Integer.highestOneBit(100) + " " + Long.rotateLeft(1, 65));
        System.out.println(Float.floatToIntBits(1.5f) + " " + Double.doubleToLongBits(-2.0) + " " + Float.intBitsToFloat(0x7f800000) + " " + Double.longBitsToDouble(0x3ff8000000000000L));
        BigInteger f = BigInteger.ONE;
        for (int k = 2; k <= 30; k++) f = f.multiply(BigInteger.valueOf(k));
        System.out.println(f + " " + f.bitLength() + " " + f.mod(BigInteger.valueOf(1000007)) + " " + new BigInteger("123456789012345678901234567890").pow(3));
        System.out.println(BigInteger.TWO.pow(100).subtract(BigInteger.ONE).isProbablePrime(20) + " " + BigInteger.valueOf(97).isProbablePrime(20));
        BigDecimal a = new BigDecimal("10.25"), b = new BigDecimal("3");
        System.out.println(a.add(b) + " " + a.multiply(b) + " " + a.divide(b, 10, RoundingMode.HALF_UP) + " " + a.setScale(1, RoundingMode.HALF_EVEN) + " " + new BigDecimal(0.1));
        Random r = new Random(42);
        System.out.println(r.nextInt(100) + " " + r.nextLong() + " " + r.nextDouble() + " " + r.nextGaussian() + " " + r.nextBoolean());
        System.out.println(Integer.toString(255, 16) + " " + Integer.parseUnsignedInt("4294967295") + " " + Long.toUnsignedString(-1L) + " " + Integer.divideUnsigned(-1, 2) + " " + Long.remainderUnsigned(-1L, 7));
        System.out.println(Integer.compare(3, 5) + " " + Double.compare(0.0, -0.0) + " " + Double.valueOf(Double.NaN).equals(Double.NaN) + " " + (0.0 == -0.0) + " " + Character.MAX_VALUE + 0);
        int[] arr = {5, 3, 9, 1, 7};
        Arrays.sort(arr);
        System.out.println(Arrays.toString(arr) + " " + Arrays.binarySearch(arr, 7) + " " + Arrays.stream(arr).sum() + " " + Arrays.hashCode(arr));
        long[][] grid = new long[3][4];
        grid[2][3] = 9;
        System.out.println(Arrays.deepToString(grid) + " " + grid.getClass().getName() + " " + int[].class + " " + grid[0].length);
        System.out.println(Math.multiplyHigh(Long.MAX_VALUE, 3) + " " + Math.fma(2.0, 3.0, 1.0) + " " + StrictMath.sinh(1) + " " + Math.expm1(1e-10) + " " + Math.log1p(1e-10));
        try { Math.addExact(Integer.MAX_VALUE, 1); } catch (ArithmeticException e) { System.out.println(e.getMessage()); }
    }
}
