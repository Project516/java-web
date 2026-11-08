import java.util.List;

public class Uses {
  enum Mode { ON, OFF }

  public static void main(String[] args) {
    Model m = new Model("m", List.of(1, 2, 3, 4));
    Runnable r = () -> System.out.println(m.label() + " " + m.group(v -> v % 2) + " " + ModelInfo.FIELDS.length);
    r.run();
    var text = """
        a text block
        """;
    System.out.println(text.strip() + " " + Model.area(new Model.Square(2)) + " " + Mode.valueOf("ON"));
  }
}
