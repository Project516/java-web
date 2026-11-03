import java.util.zip.Deflater;

public class DeflaterState {
  static void dictionary(Deflater def, String label) {
    try {
      def.setDictionary(new byte[] { 1, 2, 3 });
      System.out.println(label + ": accepted");
    } catch (IllegalArgumentException e) {
      System.out.println(label + ": " + e.getClass().getName());
    }
  }

  public static void main(String[] args) {
    Deflater def = new Deflater();
    try {
      dictionary(def, "before input");
      def.setInput(new byte[] { 1, 2, 3 });
      def.deflate(new byte[0]);
      dictionary(def, "after empty output buffer");
      def.deflate(new byte[32]);
      dictionary(def, "after output");
      def.finish();
      def.deflate(new byte[32]);
      dictionary(def, "after finish");
      def.reset();
      dictionary(def, "after reset");
    } finally {
      def.end();
    }
  }
}
