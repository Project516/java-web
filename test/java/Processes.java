import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.concurrent.TimeUnit;

public class Processes {
  static String output(Process p) throws Exception {
    return new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
  }
  public static void main(String[] args) throws Exception {
    if (args.length > 0) {
      System.out.println("nested=" + System.getProperty("process.test"));
      return;
    }
    Process echo = new ProcessBuilder("echo", "hello").start();
    System.out.println("echo=" + output(echo) + ":" + echo.waitFor());
    Process cat = new ProcessBuilder("cat").start();
    cat.getOutputStream().write("pipe text\n".getBytes(StandardCharsets.UTF_8));
    cat.getOutputStream().close();
    System.out.println("cat=" + output(cat) + ":" + cat.waitFor());
    Process nested = new ProcessBuilder(System.getProperty("java.home") + "/bin/java", "-Dprocess.test=ok", "-cp", System.getProperty("java.class.path"), "Processes", "child").start();
    System.out.println(output(nested) + ":" + nested.waitFor());
    Process exit = new ProcessBuilder("sh", "-c", "exit 17").start();
    System.out.println("exit=" + exit.waitFor());
    Path dir = Files.createTempDirectory("process-test");
    try {
      ProcessBuilder pb = new ProcessBuilder("sh", "-c", "printf '%s:%s' \"$PWD\" \"$PROC_TEST\"");
      pb.directory(dir.toFile());
      pb.environment().put("PROC_TEST", "value");
      Process env = pb.start();
      System.out.println("env=" + output(env).replace(dir.toString(), "dir") + ":" + env.waitFor());
      Path file = dir.resolve("out");
      Files.writeString(file, "input\n");
      Process redirectedInput = new ProcessBuilder("cat").redirectInput(file.toFile()).start();
      System.out.println("input=" + output(redirectedInput) + ":" + redirectedInput.waitFor());
      Process merged = new ProcessBuilder("sh", "-c", "printf out; printf err >&2").redirectErrorStream(true).start();
      String both = output(merged);
      System.out.println("merged=" + (both.contains("out") && both.contains("err")) + ":" + merged.waitFor());
      Process redirect = new ProcessBuilder("echo", "file").redirectOutput(file.toFile()).start();
      System.out.println("redirect=" + redirect.waitFor() + ":" + Files.readString(file).trim());
      Process sleep = new ProcessBuilder("sleep", "2").start();
      System.out.println("handle=" + sleep.toHandle().isAlive() + ":" + (sleep.pid() == sleep.toHandle().pid()));
      System.out.println("child=" + ProcessHandle.current().children().anyMatch(p -> p.pid() == sleep.pid()));
      System.out.println("timeout=" + sleep.waitFor(50, TimeUnit.MILLISECONDS));
      sleep.destroyForcibly();
      sleep.waitFor();
      System.out.println("alive=" + sleep.isAlive());
      Process terminated = new ProcessBuilder("sleep", "2").start();
      terminated.destroy();
      terminated.waitFor();
      System.out.println("destroy=" + terminated.isAlive());
    } finally {
      Files.deleteIfExists(dir.resolve("out"));
      Files.delete(dir);
    }
  }
}
