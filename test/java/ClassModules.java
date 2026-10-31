import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;

public class ClassModules {
    public static void main(String[] args) throws Exception {
        Class<?>[] cs = { int.class, void.class, int[].class, long[][].class, String.class, String[].class,
            ClassModules.class, ClassModules[].class, java.util.logging.Logger.class, javax.tools.ToolProvider.class };
        var lookup = MethodHandles.lookup();
        for (Class<?> c : cs) {
            Module m = c.getModule();
            System.out.println(c.getName() + " " + (m.isNamed() ? m.getName() : "unnamed") + " " + lookup.accessClass(c).getName()
                + " " + (m.isNamed() ? m.getDescriptor().version().map(Object::toString).orElse("no version") : ""));
        }
        // the JDK's modules have versions, which stack traces leave out
        StackTraceElement e = java.util.List.of(1).stream().map(x -> new Throwable().getStackTrace()).findFirst().get()[2];
        System.out.println(e.getModuleName() + " " + e);
        System.out.println(MethodType.methodType(void.class, int[].class).describeConstable().get().resolveConstantDesc(lookup));
    }
}
