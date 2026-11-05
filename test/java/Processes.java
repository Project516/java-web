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
      if (args[0].equals("wait")) { Thread.sleep(5000); return; }
      System.out.println("nested=" + System.getProperty("process.test"));
      return;
    }
    Process echo = new ProcessBuilder("echo", "hello").start();
    System.out.println("echo=" + output(echo) + ":" + echo.waitFor());
    Process cat = new ProcessBuilder("cat").start();
    cat.getOutputStream().write("pipe text\n".getBytes(StandardCharsets.UTF_8));
    cat.getOutputStream().close();
    System.out.println("cat=" + output(cat) + ":" + cat.waitFor());
    var pipeline = ProcessBuilder.startPipeline(java.util.List.of(
        new ProcessBuilder("echo", "pipeline"), new ProcessBuilder("cat")));
    System.out.println("pipeline=" + output(pipeline.get(1)) + ":" + pipeline.get(0).waitFor() + ":" + pipeline.get(1).waitFor());
    Process nested = new ProcessBuilder(System.getProperty("java.home") + "/bin/java", "-Dprocess.test=ok", "-cp", System.getProperty("java.class.path"), "Processes", "child").start();
    System.out.println(output(nested) + ":" + nested.waitFor());
    Process nestedInfo = new ProcessBuilder(System.getProperty("java.home") + "/bin/java", "-cp", System.getProperty("java.class.path"), "Processes", "wait").start();
    System.out.println("java-info=" + nestedInfo.info().command().map(s -> s.endsWith("/bin/java")).orElse(false));
    nestedInfo.destroyForcibly();
    nestedInfo.waitFor();
    try {
      new ProcessBuilder("/no-such-java-web-program").start();
      System.out.println("missing=false");
    } catch (IOException e) {
      System.out.println("missing=true");
    }
    Process background = new ProcessBuilder("sh", "-c", "sleep 2 & exit 0").start();
    System.out.println("background=" + background.waitFor(500, TimeUnit.MILLISECONDS));
    Thread.sleep(2200);
    Process release = new ProcessBuilder("cat").redirectInput(new File(System.getProperty("java.home"), "release")).start();
    System.out.println("jdk-input=" + output(release).contains("JAVA_VERSION=") + ":" + release.waitFor());
    Process tree = new ProcessBuilder("sh", "-c", "sleep 5 & wait").start();
    try {
      ProcessHandle descendant = null;
      for (int i = 0; i < 100 && descendant == null; i++) {
        descendant = tree.toHandle().children().findFirst().orElse(null);
        if (descendant == null) Thread.sleep(20);
      }
      System.out.println("descendant=" + (descendant != null && descendant.destroyForcibly()));
    } finally {
      if (!tree.waitFor(6, TimeUnit.SECONDS)) {
        tree.toHandle().descendants().forEach(ProcessHandle::destroyForcibly);
        tree.destroyForcibly();
        tree.waitFor();
      }
    }
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
      Process merged = new ProcessBuilder("sh", "-c", "printf out; printf err >&2").redirectError(file.toFile()).redirectErrorStream(true).start();
      String both = output(merged);
      System.out.println("merged=" + (both.contains("out") && both.contains("err")) + ":" + merged.waitFor());
      Process ordered = new ProcessBuilder("sh", "-c", "i=0; while [ $i -lt 100 ]; do printf a; printf b >&2; i=$((i+1)); done").redirectErrorStream(true).start();
      System.out.println("order=" + output(ordered).equals("ab".repeat(100)) + ":" + ordered.waitFor());
      Process redirect = new ProcessBuilder("echo", "file").redirectOutput(file.toFile()).start();
      System.out.println("redirect=" + redirect.waitFor() + ":" + Files.readString(file).trim());
      Process append = new ProcessBuilder("echo", "extra").redirectOutput(ProcessBuilder.Redirect.appendTo(file.toFile())).start();
      System.out.println("append=" + append.waitFor() + ":" + Files.readString(file).trim().replace("\n", "|"));
      Process sleep = new ProcessBuilder("sleep", "2").start();
      System.out.println("info=" + sleep.info().command().isPresent() + ":" + sleep.info().startInstant().isPresent() + ":" + sleep.info().totalCpuDuration().isPresent() + ":" + ProcessHandle.current().info().command().isPresent());
      System.out.println("handle=" + sleep.toHandle().isAlive() + ":" + (sleep.pid() == sleep.toHandle().pid()));
      System.out.println("child=" + ProcessHandle.current().children().anyMatch(p -> p.pid() == sleep.pid()));
      System.out.println("all=" + ProcessHandle.allProcesses().anyMatch(p -> p.pid() == ProcessHandle.current().pid()));
      System.out.println("parent=" + sleep.toHandle().parent().map(p -> p.pid() == ProcessHandle.current().pid()).orElse(false));
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
