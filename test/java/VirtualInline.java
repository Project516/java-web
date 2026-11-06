// Call sites that run one receiver class long enough to compile, then see others.
public class VirtualInline {
    interface Shape { int area(); default int twice() { return area() * 2; } }
    static abstract class Base implements Shape {
        int w = 3;
        abstract int h();
        public int area() { return w * h(); }
        int checked(int d) { return 100 / d; }
        int viaH() { return h() + 1; }
    }
    static class Sq extends Base { int h() { return w + 1; } }
    static class Tall extends Base { int h() { return w * 10; } public int area() { return -super.area(); } }
    static class Zero extends Base { int h() { return 0; } }

    static int direct(Base b) { return b.area() + b.h() + b.viaH(); }
    static int iface(Shape s) { return s.area() + s.twice(); }
    static int guarded(Base b, int d) {
        try { return b.checked(d); } catch (ArithmeticException e) { return -1; }
    }

    public static void main(String[] args) {
        Base[] all = { new Sq(), new Tall(), new Zero() };
        long sum = 0;
        for (int i = 0; i < 20000; i++) sum += direct(all[0]) + iface(all[0]) + guarded(all[0], 1 + i % 3);
        System.out.println(sum);
        for (int round = 0; round < 3; round++) {
            for (Base b : all) {
                for (int i = 0; i < 3000; i++) sum += direct(b) + iface(b) + guarded(b, i % 4);
            }
        }
        System.out.println(sum);
        try {
            direct(null);
        } catch (NullPointerException e) {
            System.out.println("npe");
        }
        try {
            iface(null);
        } catch (NullPointerException e) {
            System.out.println("npe");
        }
        for (int i = 0; i < 20000; i++) sum += direct(all[2]) + iface(all[2]);
        for (int i = 0; i < 100; i++) sum += direct(all[i % 3]) + iface(all[i % 3]);
        System.out.println(sum);
    }
}
