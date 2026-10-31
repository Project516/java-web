import java.util.ArrayList;
import java.util.List;

public class OutOfMemory {
    public static void main(String[] args) {
        List<Object[]> keep = new ArrayList<>();
        try {
            for (int i = 0; i < 4; i++) keep.add(new Object[Integer.MAX_VALUE - 8]);
            System.out.println("allocated");
        } catch (OutOfMemoryError e) {
            keep.clear();
            System.out.println("OutOfMemoryError " + e.getMessage());
        }
        try {
            Object[][] grid = new Object[4][Integer.MAX_VALUE - 8];
            System.out.println("allocated " + grid.length);
        } catch (OutOfMemoryError e) {
            System.out.println("OutOfMemoryError " + e.getMessage());
        }
        System.out.println(new Object[3].length + " " + new Object[2][3][0].length);
    }
}
