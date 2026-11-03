import java.nio.file.Files;
import java.nio.file.Path;

public class SymlinkDotDot {
  public static void main(String[] args) throws Exception {
    Path work = Path.of(args[0]);
    Path target = Path.of(args[1]);
    Path throughLink = work.resolve("link/../file");
    System.out.println(Files.readString(throughLink));
    Path created = work.resolve("link/../created");
    Files.writeString(created, "new");
    System.out.println("created " + Files.exists(target.resolve("created")) + " lexical " + Files.exists(work.resolve("created")));
    Path moved = work.resolve("link/../moved");
    Files.move(created, moved);
    System.out.println("moved " + Files.readString(target.resolve("moved")));
    Files.delete(moved);
    System.out.println("deleted " + !Files.exists(target.resolve("moved")));
  }
}
