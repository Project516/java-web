import java.lang.invoke.*;
import java.lang.reflect.*;
import java.lang.classfile.ClassFile;
import java.lang.constant.*;
import static java.lang.classfile.ClassFile.*;
import static java.lang.constant.ConstantDescs.*;

public class LinkageCaching {
  static int bootstrapCalls;
  static int constantCalls;
  static int errorCalls;
  static int customCalls;
  public static class CustomError extends LinkageError {
    public CustomError() { super("custom bootstrap error"); }
  }

  public static CallSite bootstrap(MethodHandles.Lookup lookup, String name, MethodType type) {
    if (++bootstrapCalls == 1) throw new IllegalStateException("first attempt");
    return new ConstantCallSite(MethodHandles.constant(String.class, "linked"));
  }

  public static Object constant(MethodHandles.Lookup lookup, String name, Class<?> type) {
    if (type == long.class) {
      constantCalls++;
      return 9007199254740993L;
    }
    return "value" + ++constantCalls;
  }

  public static CallSite error(MethodHandles.Lookup lookup, String name, MethodType type) {
    errorCalls++;
    throw new AssertionError("bootstrap assertion");
  }

  public static CallSite custom(MethodHandles.Lookup lookup, String name, MethodType type) {
    customCalls++;
    throw new CustomError();
  }

  public static CallSite withArgument(MethodHandles.Lookup lookup, String name, MethodType type, Object value) {
    return new ConstantCallSite(MethodHandles.constant(type.returnType(), value));
  }

  static class Loader extends ClassLoader {
    Class<?> define(byte[] bytes) { return defineClass(null, bytes, 0, bytes.length); }
  }

  public static void main(String[] args) throws Exception {
    ClassDesc owner = ClassDesc.of("LinkageCaching");
    DirectMethodHandleDesc bootstrap = MethodHandleDesc.ofMethod(DirectMethodHandleDesc.Kind.STATIC, owner, "bootstrap",
        MethodTypeDesc.of(CD_CallSite, CD_MethodHandles_Lookup, CD_String, CD_MethodType));
    DirectMethodHandleDesc constantBootstrap = MethodHandleDesc.ofMethod(DirectMethodHandleDesc.Kind.STATIC, owner, "constant",
        MethodTypeDesc.of(CD_Object, CD_MethodHandles_Lookup, CD_String, CD_Class));
    DirectMethodHandleDesc argumentBootstrap = MethodHandleDesc.ofMethod(DirectMethodHandleDesc.Kind.STATIC, owner, "withArgument",
        MethodTypeDesc.of(CD_CallSite, CD_MethodHandles_Lookup, CD_String, CD_MethodType, CD_Object));
    DynamicConstantDesc<?> constant = DynamicConstantDesc.ofNamed(constantBootstrap, "value", CD_String);
    DynamicConstantDesc<?> number = DynamicConstantDesc.ofNamed(constantBootstrap, "number", CD_long);
    DynamicConstantDesc<?> reverse = DynamicConstantDesc.ofNamed(constantBootstrap, "reverse", CD_String);
    DirectMethodHandleDesc error = MethodHandleDesc.ofMethod(DirectMethodHandleDesc.Kind.STATIC, owner, "error",
        MethodTypeDesc.of(CD_CallSite, CD_MethodHandles_Lookup, CD_String, CD_MethodType));
    DirectMethodHandleDesc custom = MethodHandleDesc.ofMethod(DirectMethodHandleDesc.Kind.STATIC, owner, "custom",
        MethodTypeDesc.of(CD_CallSite, CD_MethodHandles_Lookup, CD_String, CD_MethodType));
    MethodTypeDesc type = MethodTypeDesc.of(CD_String);
    MethodTypeDesc longType = MethodTypeDesc.of(CD_long);
    byte[] bytes = ClassFile.of().build(ClassDesc.of("GeneratedLinkage"), writer -> {
      writer.withMethodBody("invoke", type, ACC_PUBLIC | ACC_STATIC,
          code -> code.invokedynamic(DynamicCallSiteDesc.of(bootstrap, "call", type)).areturn());
      writer.withMethodBody("load", type, ACC_PUBLIC | ACC_STATIC, code -> code.ldc(constant).areturn());
      writer.withMethodBody("argument", type, ACC_PUBLIC | ACC_STATIC,
          code -> code.invokedynamic(DynamicCallSiteDesc.of(argumentBootstrap, "argument", type, constant)).areturn());
      writer.withMethodBody("number", longType, ACC_PUBLIC | ACC_STATIC, code -> code.ldc(number).lreturn());
      writer.withMethodBody("numberArgument", longType, ACC_PUBLIC | ACC_STATIC,
          code -> code.invokedynamic(DynamicCallSiteDesc.of(argumentBootstrap, "number", longType, number)).lreturn());
      writer.withMethodBody("reverse", type, ACC_PUBLIC | ACC_STATIC, code -> code.ldc(reverse).areturn());
      writer.withMethodBody("reverseArgument", type, ACC_PUBLIC | ACC_STATIC,
          code -> code.invokedynamic(DynamicCallSiteDesc.of(argumentBootstrap, "reverse", type, reverse)).areturn());
      writer.withMethodBody("error", type, ACC_PUBLIC | ACC_STATIC,
          code -> code.invokedynamic(DynamicCallSiteDesc.of(error, "error", type)).areturn());
      writer.withMethodBody("custom", type, ACC_PUBLIC | ACC_STATIC,
          code -> code.invokedynamic(DynamicCallSiteDesc.of(custom, "custom", type)).areturn());
    });
    Class<?> generated = new Loader().define(bytes);
    Method invoke = generated.getMethod("invoke");
    int failures = 0;
    Throwable first = null;
    for (int i = 0; i < 1000; i++) {
      try {
        invoke.invoke(null);
      } catch (InvocationTargetException e) {
        failures++;
        if (i == 0) first = e.getCause();
        if (i < 2) {
          Throwable failure = e.getCause();
          System.out.println("failure " + i + ": " + failure.getClass().getName() + " same " + (failure == first)
              + " cause " + (failure.getCause() == null ? "none" : failure.getCause().getClass().getName()));
        }
      }
    }
    System.out.println("bootstrap calls " + bootstrapCalls + " failures " + failures);
    System.out.println("load " + generated.getMethod("load").invoke(null));
    System.out.println("argument " + generated.getMethod("argument").invoke(null));
    System.out.println("load again " + generated.getMethod("load").invoke(null));
    System.out.println("constant calls " + constantCalls);
    System.out.println("long load " + generated.getMethod("number").invoke(null));
    System.out.println("long argument " + generated.getMethod("numberArgument").invoke(null));
    System.out.println("reverse argument " + generated.getMethod("reverseArgument").invoke(null));
    System.out.println("reverse load " + generated.getMethod("reverse").invoke(null));
    System.out.println("all constant calls " + constantCalls);
    for (int i = 0; i < 2; i++) {
      try {
        generated.getMethod("error").invoke(null);
      } catch (InvocationTargetException e) {
        System.out.println("error " + i + ": " + e.getCause().getClass().getName());
      }
    }
    System.out.println("error calls " + errorCalls);
    for (int i = 0; i < 2; i++) {
      try {
        generated.getMethod("custom").invoke(null);
      } catch (InvocationTargetException e) {
        System.out.println("custom " + i + ": " + e.getCause().getClass().getName());
      }
    }
    System.out.println("custom calls " + customCalls);
  }
}
