public class MainThreadExit {
    public static void main(String[] args) {
        Thread main = Thread.currentThread();
        main.setUncaughtExceptionHandler((thread, error) -> System.out.println("uncaught: " + error.getMessage()));
        new Thread(() -> {
            try {
                main.join();
                System.out.println("main alive: " + main.isAlive());
            } catch (InterruptedException e) {
                throw new AssertionError(e);
            }
        }).start();
        throw new RuntimeException("main failed");
    }
}
