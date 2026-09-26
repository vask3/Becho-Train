const stationCodes = {
    "Berlin Hbf": "8011160",
    "München Hbf": "8000261",
    "Frankfurt Hbf": "8000105",
    "Hamburg Hbf": "8002549"
};

document.addEventListener("DOMContentLoaded", () => {
    const checkButton = document.getElementById("checkButton");
    const stationSelect = document.getElementById("stationSelect");
    const resultBox = document.getElementById("apiResult");

    if (!checkButton || !stationSelect || !resultBox) return;

    checkButton.addEventListener("click", async () => {
        const selectedStation = stationSelect.value;
        const stationCode = stationCodes[selectedStation] || "8011160";

        resultBox.innerHTML = `Зареждам данни за ${selectedStation}...`;

        try {
            const proxyUrl = `https://becho-rail-proxy.grackiglas.workers.dev/?id=${stationCode}`;
            const response = await fetch(proxyUrl);

            if (!response.ok) {
                throw new Error(`Грешка: ${response.status}`);
            }

            const data = await response.json();
            
            resultBox.innerHTML = `<strong>Успешна връзка! 🎉</strong><br>` +
                                  `<pre style="background: #f4f4f4; padding: 10px; border-radius: 5px; text-align: left; max-height: 400px; overflow: auto;">` +
                                  JSON.stringify(data, null, 2) + 
                                  `</pre>`;

        } catch (error) {
            resultBox.innerHTML = `<span style="color: red;">Възникна проблем: ${error.message}</span>`;
        }
    });
});