import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.RoundingMode;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Properties;
import java.util.Random;
import java.util.TreeMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.IntStream;
import lib.Lib;

// A typical program, run from a jar: what it reads beyond a bare start goes in app.pack.
public class App {
  record Point(int x, int y) {}

  enum Kind { A, B, C }

  public static void main(String[] args) throws Exception {
    List<Point> points = IntStream.range(0, 50).mapToObj(i -> new Point(i, i * i)).collect(Collectors.toList());
    Map<Boolean, Long> parts = points.stream().collect(Collectors.partitioningBy(p -> p.x() % 2 == 0, Collectors.counting()));
    TreeMap<String, Integer> kinds = new TreeMap<>();
    for (Kind k : Kind.values()) kinds.put(k.name(), k.ordinal());
    String shape = switch (points.get(3)) {
      case Point(int x, int y) when x > 1 -> "big " + y;
      default -> "small";
    };
    BigDecimal price = new BigDecimal("1.10").multiply(BigDecimal.valueOf(3)).setScale(1, RoundingMode.HALF_UP);
    BigInteger factorial = BigInteger.ONE;
    for (int i = 1; i < 30; i++) factorial = factorial.multiply(BigInteger.valueOf(i));
    Instant start = Instant.now();
    String when = DateTimeFormatter.ISO_LOCAL_DATE_TIME.format(LocalDateTime.ofInstant(start, ZoneOffset.UTC))
        + " " + Duration.ofMillis(1500) + " " + ZonedDateTime.now().getZone();

    ExecutorService pool = Executors.newFixedThreadPool(2);
    Future<Integer> sum = pool.submit(() -> points.stream().mapToInt(Point::y).sum());
    CompletableFuture<String> upper = CompletableFuture.supplyAsync(() -> "async", pool).thenApply(String::toUpperCase);
    AtomicInteger ticks = new AtomicInteger();
    Thread worker = new Thread(() -> {
      synchronized (ticks) {
        ticks.incrementAndGet();
      }
    });
    worker.start();
    worker.join();
    int total = sum.get();
    String async = upper.get();
    pool.shutdown();

    Path file = Files.createTempFile("app", ".txt");
    Files.writeString(file, shape + "\n" + price + "\n");
    List<String> lines = Files.readAllLines(file);
    Files.delete(file);

    Properties props = new Properties();
    try (var in = App.class.getResourceAsStream("/app.properties")) {
      props.load(in);
    }
    System.getLogger("app").log(System.Logger.Level.DEBUG, "not shown");
    List<Integer> shuffled = new ArrayList<>(List.of(1, 2, 3, 4, 5));
    Collections.shuffle(shuffled, new Random(1));
    boolean digits = Pattern.compile("\\d+").matcher("abc123").find();
    String parsed;
    try {
      parsed = String.valueOf(Integer.parseInt("x"));
    } catch (NumberFormatException e) {
      parsed = e.getClass().getSimpleName() + " at " + e.getStackTrace()[0].getMethodName();
    }
    System.out.println(String.format("%s %s %s %s %d %s %d %s %s %s %s %b %s %s %s", parts, kinds, shape, price, factorial.bitLength(),
        when.length() > 0, total, async, ticks, lines, shuffled, digits, parsed, props.getProperty("name"),
        Optional.of(Lib.greet("app")).map(String::strip).orElse("")));
  }
}
