import java.text.NumberFormat;
import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.time.format.FormatStyle;
import java.time.format.TextStyle;
import java.util.Locale;

// Formats and names from jdk.localedata, for locales other than English.
public class Locales {
  public static void main(String[] args) {
    LocalDate day = LocalDate.of(2026, 10, 30);
    for (Locale l : new Locale[] {Locale.US, Locale.GERMANY, Locale.FRANCE, Locale.JAPAN, Locale.forLanguageTag("pt-BR")}) {
      System.out.println(l + " " + String.format(l, "%,.2f", 1234567.891) + " | "
          + NumberFormat.getCurrencyInstance(l).format(42.5) + " | "
          + day.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.FULL).withLocale(l)) + " | "
          + DayOfWeek.MONDAY.getDisplayName(TextStyle.FULL, l));
    }
  }
}
