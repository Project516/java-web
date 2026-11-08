import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;
import lib.Lib;
import proc.Generate;

@Generate
public class Model implements Lib.Named {
  private final String name;
  private final List<Integer> values;

  public Model(String name, List<Integer> values) {
    this.name = name;
    this.values = values;
  }

  public String name() {
    return name;
  }

  public <K> Map<K, List<Integer>> group(Function<Integer, K> key) {
    return values.stream().collect(Collectors.groupingBy(key));
  }

  sealed interface Shape permits Circle, Square {}

  record Circle(double r) implements Shape {}

  record Square(double side) implements Shape {}

  static double area(Shape s) {
    return switch (s) {
      case Circle c -> Math.PI * c.r() * c.r();
      case Square q -> q.side() * q.side();
    };
  }
}
