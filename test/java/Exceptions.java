import java.util.*;

public class Exceptions {
    static class AppException extends Exception {
        AppException(String msg, Throwable cause) { super(msg, cause); }
    }

    static int depth(int n) { return n == 0 ? 0 : 1 + depth(n - 1); }

    static Object castToString(Object o) { return (String) o; }

    static void fail(int level) throws AppException {
        try {
            if (level == 0) throw new IllegalStateException("bottom");
            fail(level - 1);
        } catch (IllegalStateException e) {
            throw new AppException("wrapped at " + level, e);
        }
    }

    static String tryFinally() {
        StringBuilder sb = new StringBuilder();
        try {
            sb.append("try ");
            return sb.append("return ").toString();
        } finally {
            sb.append("finally");
            System.out.println("finally ran: " + sb);
        }
    }

    public static void main(String[] args) throws Exception {
        try {
            fail(2);
        } catch (AppException e) {
            System.out.println(e.getMessage() + " / cause: " + e.getCause().getMessage());
            StackTraceElement top = e.getCause().getStackTrace()[0];
            System.out.println(top.getMethodName() + " line " + top.getLineNumber() + " in " + top.getFileName());
        }
        System.out.println(tryFinally());
        try {
            int[] a = new int[3];
            a[5] = 1;
        } catch (ArrayIndexOutOfBoundsException e) {
            System.out.println(e.getMessage());
        }
        try {
            Object o = "s";
            Integer i = (Integer) o;
        } catch (ClassCastException e) {
            System.out.println(e.getMessage());
        }
        try {
            Object o = new String[1];
            Integer[] i = (Integer[]) o;
        } catch (ClassCastException e) {
            System.out.println(e.getMessage());
        }
        try {
            Object o = new int[1];
            Exceptions[] x = (Exceptions[]) o;
        } catch (ClassCastException e) {
            System.out.println(e.getMessage());
        }
        // compiled code fails the cast once the method is hot
        try {
            for (int i = 0; i < 20000; i++) castToString(i < 19999 ? "s" : new Exceptions());
        } catch (ClassCastException e) {
            System.out.println(e.getMessage());
        }
        try {
            new java.io.FileInputStream("/no/such/file");
        } catch (java.io.FileNotFoundException e) {
            System.out.println(e.getMessage() + " at " + e.getStackTrace()[0] + ", " + e.getStackTrace()[1]);
        }
        try {
            System.loadLibrary("NoSuchLibrary");
        } catch (UnsatisfiedLinkError e) {
            System.out.println("no library");
        }
        try {
            System.out.println(10 / (args.length));
        } catch (ArithmeticException e) {
            System.out.println(e);
        }
        try {
            depth(100000);
        } catch (StackOverflowError e) {
            System.out.println("stack overflow caught, " + e.getStackTrace().length + " frames");
        }
        try (AutoCloseable c1 = () -> System.out.println("close 1"); AutoCloseable c2 = () -> System.out.println("close 2")) {
            System.out.println("in try");
        }
        try {
            List.of(1, 2).add(3);
        } catch (UnsupportedOperationException e) {
            System.out.println("immutable");
        }
        Throwable t = new RuntimeException("outer", new Error("inner"));
        t.addSuppressed(new Exception("suppressed"));
        t.printStackTrace(System.out);
        throw new IllegalArgumentException("uncaught at end");
    }
}
