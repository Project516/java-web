import java.io.IOException;

// Starts each command named in the arguments, found through the PATH the test sets.
// With -env first, each child gets its own environment, so the JDK searches PATH itself.
public class PathLookup {
    public static void main(String[] args) throws Exception {
        boolean ownEnvironment = args.length > 0 && args[0].equals("-env");
        for (String command : ownEnvironment ? java.util.Arrays.copyOfRange(args, 1, args.length) : args) {
            try {
                ProcessBuilder pb = new ProcessBuilder(command);
                if (ownEnvironment) pb.environment().put("PATH_LOOKUP", "1");
                Process p = pb.start();
                System.out.println(command + " exit " + p.waitFor());
            } catch (IOException e) {
                System.out.println(command + " " + e.getCause().getMessage());
            }
        }
    }
}
