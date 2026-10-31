import java.util.*;

public class Shapes {
    sealed interface Shape permits Circle, Rect {}
    record Circle(double r) implements Shape {}
    record Rect(double w, double h) implements Shape {}

    static double area(Shape s) {
        return switch (s) {
            case Circle(double r) -> Math.PI * r * r;
            case Rect(double w, double h) -> w * h;
        };
    }

    public static void main(String[] args) throws Exception {
        List<Shape> shapes = List.of(new Circle(1), new Rect(2, 3), new Circle(0.5));
        for (Shape s : shapes) System.out.printf("%-28s area %.2f%n", s, area(s));
        Thread t = new Thread(() -> System.out.println("hello from " + Thread.currentThread().getName()));
        t.start();
        t.join();
        Map<String, Integer> counts = new TreeMap<>();
        for (String w : "the quick brown fox jumps over the lazy dog the end".split(" ")) counts.merge(w, 1, Integer::sum);
        System.out.println(counts);
    }
}
