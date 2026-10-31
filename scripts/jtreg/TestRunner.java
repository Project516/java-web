import java.util.concurrent.atomic.AtomicInteger;
import org.junit.platform.engine.discovery.DiscoverySelectors;
import org.junit.platform.launcher.LauncherConstants;
import org.junit.platform.launcher.core.LauncherDiscoveryRequestBuilder;
import org.junit.platform.launcher.core.LauncherFactory;
import org.junit.platform.launcher.listeners.SummaryGeneratingListener;
import org.testng.IConfigurationListener;
import org.testng.ITestListener;
import org.testng.ITestResult;
import org.testng.SkipException;
import org.testng.TestNG;

// Runs one TestNG or JUnit test class with jtreg's pass rules:
//   java TestRunner testng|junit <class>
public class TestRunner {
    public static void main(String[] args) throws Exception {
        if (args.length != 2) {
            System.err.println("usage: TestRunner testng|junit <class>");
            System.exit(2);
        }
        Class<?> c = Class.forName(args[1], false, TestRunner.class.getClassLoader());
        if (args[0].equals("testng")) testng(c);
        else junit(c);
    }

    static void testng(Class<?> c) throws Exception {
        AtomicInteger failures = new AtomicInteger();
        AtomicInteger configFailures = new AtomicInteger();
        class Listener implements ITestListener, IConfigurationListener {
            public void onTestFailure(ITestResult r) { failures.incrementAndGet(); report(r); }
            public void onTestSkipped(ITestResult r) {
                Throwable t = r.getThrowable();
                if (t != null && !(t instanceof SkipException)) onTestFailure(r);
            }
            public void onConfigurationFailure(ITestResult r) { configFailures.incrementAndGet(); report(r); }
            void report(ITestResult r) {
                System.err.println("FAILED " + r.getMethod().getMethodName());
                if (r.getThrowable() != null) r.getThrowable().printStackTrace();
            }
        }
        TestNG testng = new TestNG(false);
        testng.setMixed(false);
        testng.setDefaultSuiteName(c.getName());
        testng.setTestClasses(new Class<?>[] {c});
        testng.addListener(new Listener());
        testng.setOutputDirectory(".");
        testng.run();
        if (failures.get() > 0 || configFailures.get() > 0)
            throw new Exception("config failures: " + configFailures + ", test failures: " + failures);
    }

    static void junit(Class<?> c) throws Exception {
        Thread.currentThread().setContextClassLoader(c.getClassLoader());
        var request = LauncherDiscoveryRequestBuilder.request()
            .selectors(DiscoverySelectors.selectClass(c))
            .configurationParameter(LauncherConstants.CRITICAL_DISCOVERY_ISSUE_SEVERITY_PROPERTY_NAME, "INFO")
            .build();
        var summary = new SummaryGeneratingListener();
        try (var session = LauncherFactory.openSession()) {
            session.getLauncher().execute(request, summary);
        }
        var s = summary.getSummary();
        if (s.getTotalFailureCount() > 0) {
            s.printFailuresTo(new java.io.PrintWriter(System.err, true), 20);
            throw new Exception("JUnit test failures: " + s.getTotalFailureCount());
        }
    }
}
