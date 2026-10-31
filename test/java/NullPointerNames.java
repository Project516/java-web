// javac: -g
public class NullPointerNames {
    static class Box {
        Box inner;
        String label;
        int[] items;
    }

    String title;
    Box box;

    static void param(String text, long n, Box b) { b.label.length(); }
    static void local() { Box b = new Box(); String t = null; b.label = t; t.trim(); }
    static void localArray() { Box[] boxes = new Box[2]; int idx = 1; boxes[idx].inner = null; }
    static void fieldChain() { Box b = new Box(); b.inner.inner.label = "x"; }
    static void reused() { String a = null; a = "x"; { String c = null; c.length(); } }
    static void loopVar() { String[] names = new String[2]; for (String n : names) n.length(); }
    void inst() { this.box.items[0] = 1; }
    void instTitle() { title.length(); }

    interface Body { void run(); }

    static void check(String label, Body b) {
        try {
            b.run();
            System.out.println(label + ": no exception");
        } catch (NullPointerException e) {
            System.out.println(label + ": " + e.getMessage());
        }
    }

    public static void main(String[] args) {
        check("param", () -> param("t", 1L, new Box()));
        check("local", () -> local());
        check("localArray", () -> localArray());
        check("fieldChain", () -> fieldChain());
        check("reused", () -> reused());
        check("loopVar", () -> loopVar());
        check("inst", () -> new NullPointerNames().inst());
        check("instTitle", () -> new NullPointerNames().instTitle());
    }
}
