export async function shutdownHttpServer(httpServer, closeApplication) {
    const httpClosed = new Promise((resolve, reject) => {
        httpServer.close((error) => {
            if (error)
                reject(error);
            else
                resolve();
        });
    });
    await closeApplication();
    await httpClosed;
}
