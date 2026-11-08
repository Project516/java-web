package proc;

import java.io.Writer;
import java.util.Set;
import javax.annotation.processing.AbstractProcessor;
import javax.annotation.processing.RoundEnvironment;
import javax.annotation.processing.SupportedAnnotationTypes;
import javax.lang.model.SourceVersion;
import javax.lang.model.element.Element;
import javax.lang.model.element.TypeElement;

// Writes <Class>Info with the field names of each @Generate class.
@SupportedAnnotationTypes("proc.Generate")
public class GenerateProcessor extends AbstractProcessor {
  @Override
  public SourceVersion getSupportedSourceVersion() {
    return SourceVersion.latestSupported();
  }

  @Override
  public boolean process(Set<? extends TypeElement> annotations, RoundEnvironment round) {
    for (Element e : round.getElementsAnnotatedWith(Generate.class)) {
      String name = e.getSimpleName() + "Info";
      StringBuilder fields = new StringBuilder();
      for (Element member : e.getEnclosedElements()) {
        if (member.getKind().isField()) fields.append('"').append(member.getSimpleName()).append("\", ");
      }
      try (Writer w = processingEnv.getFiler().createSourceFile(name, e).openWriter()) {
        w.write("public final class " + name + " { public static final String[] FIELDS = { " + fields + "}; }\n");
      } catch (Exception x) {
        throw new RuntimeException(x);
      }
    }
    return true;
  }
}
