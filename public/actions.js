var socket = io();

socket.on('actions', (data) => {
    if (data) {
        let element = document.getElementById("action_id");
        
        element.options.length = 0;     // clear list

        for (let i = 0; i < data.length; i++) {
            let option = document.createElement("option");

            option.text = data[i].title;
            option.value = data[i].value;
            element.add(option);
        }
    }
});
