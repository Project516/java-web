import java.util.*;

public class NullPointers {
    interface Body { void run() throws Exception; }

    static class Node {
        Node next;
        int val;
        int[] data;
        String name;
        long big;
        double dbl;
        Node self() { return null; }
    }

    static int[] sia;
    static Object[] soa;
    static Node sn;
    Node field;
    String name;

    static Node nothing() { return null; }
    static int[] nothingArr() { return null; }
    static String nothingStr(int a, long b, String c) { return null; }
    static String nothingMany(String a, Object b, StringBuilder c, int[][] d, List<String> e, double f) { return null; }

    static void check(String label, Body b) {
        try {
            b.run();
            System.out.println(label + ": no exception");
        } catch (NullPointerException e) {
            System.out.println(label + ": " + e.getMessage());
        } catch (Exception e) {
            System.out.println(label + ": " + e);
        }
    }

    static void invokeLocal() { String s = null; s.length(); }
    static void invokeParam(String s) { s.length(); }
    static void invokeParam3(long a, String b, int c, Node d) { d.self(); }
    static void invokeWritten(String s) { s = null; s.length(); }
    static void invokeStatic(Node n) { n.val++; }
    static void invokeInterface() { List<String> l = null; l.size(); }
    static void invokeArrayClone() { int[] a = null; a.clone(); }
    static void unbox() { Integer i = null; int v = i; }
    static void unboxLong() { Long i = null; long v = i + 1; }
    static void forEachList() { List<String> l = null; for (String s : l) { } }
    static void forEachArray() { String[] a = null; for (String s : a) { } }
    static void stringSwitch() { String s = null; switch (s) { case "a": break; default: } }
    static void ternary(boolean f) { String a = null, b = null; (f ? a : b).length(); }
    static void loopMerge() {
        Node n = new Node();
        for (int i = 0; i < 3; i++) {
            if (i == 2) n = null;
            n.val = i;
        }
    }

    void instField() { this.field.val = 1; }
    void instFieldRead() { System.out.println(field.val); }
    void instParam(String a, long b, String c) { c.length(); }
    void instThis() { name.length(); }

    static void readInt() { Node p = null; int v = p.val; }
    static void readLong() { Node p = null; long v = p.big; }
    static void readObj() { Node p = null; Object v = p.next; }
    static void writeInt() { Node p = null; p.val = 1; }
    static void writeLong() { Node p = null; p.big = 1L; }
    static void writeDouble() { Node p = null; p.dbl = 1.0; }
    static void writeObj() { Node p = null; p.name = "x"; }

    static void loadInt() { int[] a = null; int v = a[0]; }
    static void loadLong() { long[] a = null; long v = a[0]; }
    static void loadFloat() { float[] a = null; float v = a[0]; }
    static void loadDouble() { double[] a = null; double v = a[0]; }
    static void loadObj() { Object[] a = null; Object v = a[0]; }
    static void loadByte() { byte[] a = null; byte v = a[0]; }
    static void loadBool() { boolean[] a = null; boolean v = a[0]; }
    static void loadChar() { char[] a = null; char v = a[0]; }
    static void loadShort() { short[] a = null; short v = a[0]; }
    static void storeInt() { int[] a = null; a[0] = 1; }
    static void storeLong() { long[] a = null; a[0] = 1L; }
    static void storeFloat() { float[] a = null; a[0] = 1f; }
    static void storeDouble() { double[] a = null; a[0] = 1.0; }
    static void storeObj() { Object[] a = null; a[0] = "x"; }
    static void storeByte() { byte[] a = null; a[0] = 1; }
    static void storeBool() { boolean[] a = null; a[0] = true; }
    static void storeChar() { char[] a = null; a[0] = 'c'; }
    static void storeShort() { short[] a = null; a[0] = 1; }
    static void arrayLength() { int[] a = null; int n = a.length; }
    static void arrayLengthElem() { int[][] m = new int[3][]; int n = m[2].length; }

    static void throwNull() { RuntimeException r = null; throw r; }
    static void syncNull() { Object o = null; synchronized (o) { } }

    static void staticFieldRead() { int v = sn.val; }
    static void staticArrayStore() { soa[0] = "x"; }
    static void staticArrayLoad() { int v = sia[1]; }
    static void staticFieldChain() { sn.next.val = 3; }

    static void returnInvoke() { nothing().self(); }
    static void returnField() { int v = nothing().val; }
    static void returnArray() { int v = nothingArr()[0]; }
    static void returnArgs() { nothingStr(1, 2L, "x").length(); }
    static void returnMany() { nothingMany("a", null, null, null, null, 1.0).length(); }
    static void returnChain() { new Node().self().self().val = 1; }

    static void elemInvoke() { String[] a = new String[2]; a[1].length(); }
    static void elemLocalIndex() { String[] a = new String[2]; int i = 1; a[i].length(); }
    static void elemComplexIndex() { String[] a = new String[2]; int i = 0; a[i + 1].length(); }
    static void elemConstIndex() { String[] a = new String[2]; a[-1 + 1].length(); }
    static void elemBigIndex() { String[] a = new String[1000]; a[300].length(); }
    static void elemNested() { int[][] a = new int[2][]; int i = 1, j = 0; int v = a[i][j]; }
    static void elemNested2() { int[][] a = new int[2][]; a[1][0] = 3; }
    static void elemStaticIndex() { Node[] a = new Node[2]; a[sn.val].val = 1; }
    static void elemFieldArray() { Node n = new Node(); n.data[0] = 1; }
    static void elemFieldArrayLen() { Node n = new Node(); int v = n.data.length; }

    static Node chain(int length) {
        Node head = null;
        for (int i = 0; i < length; i++) {
            Node n = new Node();
            n.next = head;
            head = n;
        }
        return head;
    }
    static void deepChain() { Node n = chain(7); int v = n.next.next.next.next.next.next.next.val; }
    static void deepChain2() { Node n = chain(3); int v = n.next.next.next.next.next.next.val; }

    static void explicit() { throw new NullPointerException(); }
    static void explicitMessage() { throw new NullPointerException("explicit message"); }
    static void requireNonNull() { Objects.requireNonNull(null); }
    static void requireNonNullMsg() { Objects.requireNonNull(null, "required"); }
    static void mapOf() { Map.of("a", null); }
    static void arrayListAddAll() { new ArrayList<String>().addAll(null); }
    static void compareTo() { "abc".compareTo(null); }
    static void stringJoin() { String.join(",", (Iterable<String>) null); }
    static void arraycopy() { System.arraycopy(null, 0, new int[1], 0, 1); }

    static void reflect() throws Exception {
        NullPointers.class.getDeclaredMethod("instThis").invoke(new NullPointers());
    }

    public static void main(String[] args) throws Exception {
        check("invokeLocal", () -> invokeLocal());
        check("invokeParam", () -> invokeParam(null));
        check("invokeParam3", () -> invokeParam3(1L, "x", 2, null));
        check("invokeWritten", () -> invokeWritten("x"));
        check("invokeStatic", () -> invokeStatic(null));
        check("invokeInterface", () -> invokeInterface());
        check("invokeArrayClone", () -> invokeArrayClone());
        check("unbox", () -> unbox());
        check("unboxLong", () -> unboxLong());
        check("forEachList", () -> forEachList());
        check("forEachArray", () -> forEachArray());
        check("stringSwitch", () -> stringSwitch());
        check("ternary", () -> ternary(true));
        check("loopMerge", () -> loopMerge());

        check("instField", () -> new NullPointers().instField());
        check("instFieldRead", () -> new NullPointers().instFieldRead());
        check("instParam", () -> new NullPointers().instParam("a", 1L, null));
        check("instThis", () -> new NullPointers().instThis());

        check("readInt", () -> readInt());
        check("readLong", () -> readLong());
        check("readObj", () -> readObj());
        check("writeInt", () -> writeInt());
        check("writeLong", () -> writeLong());
        check("writeDouble", () -> writeDouble());
        check("writeObj", () -> writeObj());

        check("loadInt", () -> loadInt());
        check("loadLong", () -> loadLong());
        check("loadFloat", () -> loadFloat());
        check("loadDouble", () -> loadDouble());
        check("loadObj", () -> loadObj());
        check("loadByte", () -> loadByte());
        check("loadBool", () -> loadBool());
        check("loadChar", () -> loadChar());
        check("loadShort", () -> loadShort());
        check("storeInt", () -> storeInt());
        check("storeLong", () -> storeLong());
        check("storeFloat", () -> storeFloat());
        check("storeDouble", () -> storeDouble());
        check("storeObj", () -> storeObj());
        check("storeByte", () -> storeByte());
        check("storeBool", () -> storeBool());
        check("storeChar", () -> storeChar());
        check("storeShort", () -> storeShort());
        check("arrayLength", () -> arrayLength());
        check("arrayLengthElem", () -> arrayLengthElem());

        check("throwNull", () -> throwNull());
        check("syncNull", () -> syncNull());

        check("staticFieldRead", () -> staticFieldRead());
        check("staticArrayStore", () -> staticArrayStore());
        check("staticArrayLoad", () -> staticArrayLoad());
        check("staticFieldChain", () -> staticFieldChain());

        check("returnInvoke", () -> returnInvoke());
        check("returnField", () -> returnField());
        check("returnArray", () -> returnArray());
        check("returnArgs", () -> returnArgs());
        check("returnMany", () -> returnMany());
        check("returnChain", () -> returnChain());

        check("elemInvoke", () -> elemInvoke());
        check("elemLocalIndex", () -> elemLocalIndex());
        check("elemComplexIndex", () -> elemComplexIndex());
        check("elemConstIndex", () -> elemConstIndex());
        check("elemBigIndex", () -> elemBigIndex());
        check("elemNested", () -> elemNested());
        check("elemNested2", () -> elemNested2());
        check("elemStaticIndex", () -> { sn = new Node(); elemStaticIndex(); });
        check("elemFieldArray", () -> elemFieldArray());
        check("elemFieldArrayLen", () -> elemFieldArrayLen());

        check("deepChain", () -> deepChain());
        check("deepChain2", () -> deepChain2());

        check("explicit", () -> explicit());
        check("explicitMessage", () -> explicitMessage());
        check("requireNonNull", () -> requireNonNull());
        check("requireNonNullMsg", () -> requireNonNullMsg());
        check("mapOf", () -> mapOf());
        check("arrayListAddAll", () -> arrayListAddAll());
        check("compareTo", () -> compareTo());
        check("stringJoin", () -> stringJoin());
        check("arraycopy", () -> arraycopy());
        check("reflect", () -> reflect());

        String s = args.length > 5 ? "x" : null;
        System.out.println(s.length());
    }
}
