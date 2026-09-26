const myClientId = "aefd8b2f360ebfe5cab9f402d049139e";
const myClientSecret = "f1063739bb9c58fdc5e8ba9208e68d9b";

const stationCodes = {
    "Berlin Hbf": "8011160",
    "München Hbf": "8000261",
    "Frankfurt Hbf": "8000105"
};

document.getElementById("checkButton").addEventListener("click", async function() {
    const selectedStation = document.getElementById("stationSelect").value;
    const stationCode = stationCodes[selectedStation];
    const resultBox = document.getElementById("apiResult");

    resultBox.innerHTML = `Loading data for ${selectedStation} (EVA: ${stationCode})... ⏳`;

    try {
        const targetUrl = `https://apis.deutschebahn.com/db-api-marketplace/apis/stada/v2/stations/${stationCode}`;
        const proxyUrl = `https://corsproxy.io/?` + encodeURIComponent(targetUrl);

        const directResponse = await fetch(proxyUrl, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'DB-Client-Id': myClientId,
                'DB-Api-Key': myClientSecret
            }
        });

        if (!directResponse.ok) {
            throw new Error(`HTTP error! Status: ${directResponse.status}`);
        }

        const data = await directResponse.json();
        
        resultBox.innerHTML = `<strong>Successfully connected to StaDa API! 🎉</strong><br>` +
                              `<pre>${JSON.stringify(data, null, 2)}</pre>`;

    } catch (error) {
        resultBox.innerHTML = `<span style="color: red;">Request error: ${error.message}</span>`;
    }
});