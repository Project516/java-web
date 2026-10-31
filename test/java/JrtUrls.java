import java.io.InputStream;
import java.io.StringReader;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.transform.stream.StreamSource;
import javax.xml.validation.Schema;
import javax.xml.validation.SchemaFactory;
import org.xml.sax.InputSource;
import org.xml.sax.SAXException;

// jrt: URLs for the JDK's own resources, and the XML Schema validation that
// loads the built-in catalog through one.
public class JrtUrls {
  static final String XSD = """
      <xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
        <xs:element name="device">
          <xs:complexType>
            <xs:sequence>
              <xs:element name="speed" type="xs:decimal"/>
              <xs:element name="name" type="xs:string"/>
            </xs:sequence>
            <xs:attribute name="id" type="xs:int" use="required"/>
          </xs:complexType>
        </xs:element>
      </xs:schema>
      """;

  static void validate(Schema schema, String xml) {
    try {
      schema.newValidator().validate(new StreamSource(new StringReader(xml)));
      System.out.println("valid");
    } catch (SAXException | java.io.IOException e) {
      System.out.println("invalid: " + e.getMessage());
    }
  }

  public static void main(String[] args) throws Exception {
    URL url = URI.create("jrt:/java.xml/jdk/xml/internal/jdkcatalog/JDKCatalog.xml").toURL();
    try (InputStream in = url.openStream()) {
      String text = new String(in.readAllBytes(), StandardCharsets.UTF_8);
      System.out.println("catalog " + text.length() + " chars, starts " + text.substring(0, 5));
    }
    System.out.println("content length " + url.openConnection().getContentLengthLong());
    URL props = URI.create("jrt:/java.base/sun/net/www/content-types.properties").toURL();
    try (InputStream in = props.openStream()) {
      System.out.println("content-types " + in.readAllBytes().length + " bytes");
    }
    try {
      URI.create("jrt:/java.xml/no/such/file.txt").toURL().openStream().close();
    } catch (java.io.IOException e) {
      System.out.println(e.getClass().getName() + " " + e.getMessage());
    }

    var fs = FileSystems.getFileSystem(URI.create("jrt:/"));
    Path catalog = fs.getPath("/modules/java.xml/jdk/xml/internal/jdkcatalog/JDKCatalog.xml");
    System.out.println("jrt fs " + Files.size(catalog) + " bytes");

    // the DTD comes from the JDK's built-in catalog, not the network
    String xhtml = "<?xml version=\"1.0\"?>\n<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0 Strict//EN\" "
        + "\"http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd\">\n"
        + "<html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>t</title></head><body><p>a&nbsp;b</p></body></html>";
    var doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(new InputSource(new StringReader(xhtml)));
    System.out.println("xhtml " + doc.getDocumentElement().getTextContent().length() + " chars, doctype " + doc.getDoctype().getPublicId());

    Schema schema = SchemaFactory.newInstance(XMLConstants.W3C_XML_SCHEMA_NS_URI)
        .newSchema(new StreamSource(new StringReader(XSD)));
    validate(schema, "<device id=\"7\"><speed>1.5</speed><name>Ada</name></device>");
    validate(schema, "<device id=\"x\"><speed>1.5</speed><name>Ada</name></device>");
    validate(schema, "<device id=\"7\"><name>Ada</name></device>");
  }
}
