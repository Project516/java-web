public class OsVersion {
  public static void main(String[] args) throws Exception {
    System.out.println(System.getProperty("os.name") + " " + System.getProperty("os.version"));
    Process p = new ProcessBuilder("uname", "-r").start();
    System.out.println(System.getProperty("os.version").equals(new String(p.getInputStream().readAllBytes()).trim()));
  }
}
