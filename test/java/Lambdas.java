import java.util.*;
import java.util.function.*;
import java.util.stream.*;

public class Lambdas {
    record Point(int x, int y) {}
    record Named(String name, double weight, long id) {}
    sealed interface Shape permits Circle, Square {}
    record Circle(double r) implements Shape {}
    record Square(int side) implements Shape {}
    enum Color { RED, GREEN, BLUE }

    static String describe(Object o) {
        return switch (o) {
            case null -> "null!";
            case Integer i when i > 10 -> "big int " + i;
            case Integer i -> "int " + i;
            case String s -> "string " + s.length();
            case Point(int x, int y) -> "point " + (x + y);
            default -> "other " + o.getClass().getSimpleName();
        };
    }

    static double area(Shape s) {
        return switch (s) {
            case Circle c -> Math.PI * c.r() * c.r();
            case Square q -> q.side() * q.side();
        };
    }

    static String color(Color c) {
        return switch (c) {
            case RED -> "r";
            case GREEN -> "g";
            case BLUE -> "b";
        };
    }

    public static void main(String[] args) {
        Runnable r = () -> System.out.println("run");
        r.run();
        int base = 7;
        Function<Integer, Integer> add = x -> x + base;
        System.out.println("add " + add.apply(5));
        BiFunction<String, Integer, String> rep = String::repeat;
        System.out.println(rep.apply("ab", 3));
        Supplier<List<String>> sup = ArrayList::new;
        List<String> list = sup.get();
        list.add("b"); list.add("a"); list.add("c");
        list.sort(Comparator.naturalOrder());
        System.out.println(list);
        IntBinaryOperator mul = (a, b) -> a * b;
        System.out.println(mul.applyAsInt(6, 7));
        ToIntFunction<String> len = String::length;
        System.out.println(len.applyAsInt("hello"));
        long big = 1L << 40; char ch = 'x'; double d = 2.5; float fl = 1.25f; boolean bo = true;
        System.out.println("mix " + big + " " + ch + " " + d + " " + fl + " " + bo + " " + null + " " + list);
        Point p = new Point(3, 4);
        System.out.println(p + " " + p.hashCode() + " " + p.equals(new Point(3, 4)) + " " + p.equals(new Point(4, 3)));
        Named n = new Named("x", 1.5, 99L);
        System.out.println(n + " " + n.equals(new Named("x", 1.5, 99L)) + " " + n.hashCode());
        for (Object o : new Object[] {null, 5, 50, "hey", p, 3.0}) System.out.println(describe(o));
        System.out.printf("%.3f %.1f%n", area(new Circle(1)), area(new Square(3)));
        for (Color c : Color.values()) System.out.print(color(c));
        System.out.println();
        System.out.println(IntStream.rangeClosed(1, 10).filter(i -> i % 2 == 0).map(i -> i * i).sum());
        System.out.println(Stream.of("x", "yy", "zzz").map(String::toUpperCase).collect(Collectors.joining(",", "[", "]")));
        Map<Integer, List<String>> byLen = Stream.of("a", "bb", "cc", "ddd").collect(Collectors.groupingBy(String::length));
        System.out.println(byLen);
        // lambda classes reflect as on HotSpot, as libraries that walk fields expect
        Supplier<Double> plain = () -> 1.0;
        int k = args.length + 2;
        IntSupplier captures = () -> k;
        for (Object l : new Object[] {plain, captures}) {
            Class<?> c = l.getClass();
            System.out.println(Arrays.stream(c.getDeclaredFields()).map(f -> f.getType() + " " + f.getName()).toList()
                + " " + Arrays.stream(c.getDeclaredMethods()).map(m -> m.getName()).toList()
                + " " + c.getDeclaredConstructors().length);
        }
    }
}
