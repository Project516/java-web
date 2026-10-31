import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;

public class Nestmates {
    interface Shape {
        private int secret(int x) { return x * 2; }
    }

    static class Square implements Shape {
        int call() throws Throwable {
            // private access between nestmates, before anything asks for the nest host
            var mh = MethodHandles.lookup().findSpecial(Shape.class, "secret", MethodType.methodType(int.class, int.class), Square.class);
            return (int) mh.invoke(this, 21);
        }
    }

    public static void main(String[] args) throws Throwable {
        System.out.println(new Square().call());
        System.out.println(Square.class.getNestHost().getName() + " " + Shape.class.isNestmateOf(Square.class) + " " + String.class.isNestmateOf(Nestmates.class));
        System.out.println(Nestmates.class.getNestMembers().length);
    }
}
